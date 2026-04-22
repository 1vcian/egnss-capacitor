package it.demo.egnss

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.IOException
import java.util.UUID

/**
 * External Bluetooth GNSS antenna adapter for Android.
 *
 * Supports:
 *   - **Classic SPP** (Bluetooth Classic, RFCOMM): the standard profile
 *     used by the vast majority of consumer GNSS receivers (Bad Elf,
 *     Garmin GLO, Dual XGPS, most u-blox). We open an RFCOMM socket on
 *     the well-known SPP UUID `00001101-...-805F9B34FB` and read NMEA
 *     sentences line by line on a background thread.
 *   - **BLE UART** fallback: Nordic UART Service (NUS) for receivers
 *     that only speak BLE (SparkFun RTK Facet, some ESP32 adapters).
 *
 * The consumer does not need to know which transport is in use; the
 * manager picks the right one based on the scan result and exposes the
 * same "sentence stream" callback.
 */
internal class BluetoothManager(
    private val context: Context,
    private val onSentence: (String) -> Unit,
    private val onStatus: (connected: Boolean, deviceId: String?, deviceName: String?, error: String?) -> Unit,
    private val onScanResult: (deviceId: String, name: String?, rssi: Int) -> Unit,
    private val onScanFinished: () -> Unit = {},
) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val adapter: BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager)?.adapter

    private var classicSocket: BluetoothSocket? = null
    private var readerThread: Thread? = null
    private var gatt: BluetoothGatt? = null
    private var connectedDevice: BluetoothDevice? = null
    private var scanning = false

    fun isAvailable(): Boolean = adapter != null && adapter.isEnabled

    // ---------------- Scanning ----------------

    @SuppressLint("MissingPermission")
    fun startScan(timeoutMs: Long) {
        val a = adapter ?: return
        if (!hasBluetoothPermissions()) {
            onStatus(false, null, null, "Bluetooth permissions not granted")
            return
        }
        if (scanning) return
        scanning = true

        // Paired classic devices are returned immediately (SPP doesn't discover live).
        try {
            for (d in a.bondedDevices ?: emptySet()) {
                onScanResult(d.address, safeName(d), 0)
            }
        } catch (_: SecurityException) { /* ignored */ }

        // BLE scan to catch Bluetooth LE receivers nearby.
        val scanner = a.bluetoothLeScanner
        if (scanner != null) {
            try {
                scanner.startScan(null, ScanSettings.Builder().build(), bleScanCallback)
            } catch (e: SecurityException) {
                Log.w(TAG, "BLE scan start failed: ${e.message}")
            }
            mainHandler.postDelayed({ stopScan() }, timeoutMs)
        } else {
            scanning = false
            mainHandler.post { onScanFinished() }
        }
    }

    @SuppressLint("MissingPermission")
    fun stopScan() {
        if (!scanning) return
        scanning = false
        try {
            adapter?.bluetoothLeScanner?.stopScan(bleScanCallback)
        } catch (_: SecurityException) { /* ignored */ }
        mainHandler.post { onScanFinished() }
    }

    private val bleScanCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val d = result.device ?: return
            onScanResult(d.address, safeName(d), result.rssi)
        }
    }

    // ---------------- Connect ----------------

    @SuppressLint("MissingPermission")
    fun connect(deviceId: String) {
        val a = adapter ?: run {
            onStatus(false, deviceId, null, "Bluetooth unavailable")
            return
        }
        if (!hasBluetoothPermissions()) {
            onStatus(false, deviceId, null, "Bluetooth permissions not granted")
            return
        }
        val device = try {
            a.getRemoteDevice(deviceId)
        } catch (e: IllegalArgumentException) {
            onStatus(false, deviceId, null, e.message ?: "Invalid device id")
            return
        }
        connectedDevice = device

        // Prefer classic SPP when the device is bonded — most commercial GNSS
        // receivers fall into this bucket and BLE exposure on the same
        // hardware is often partial.
        val bonded = try {
            a.bondedDevices?.any { it.address == device.address } == true
        } catch (_: SecurityException) { false }

        if (bonded || device.type == BluetoothDevice.DEVICE_TYPE_CLASSIC ||
            device.type == BluetoothDevice.DEVICE_TYPE_DUAL) {
            connectClassic(device)
        } else {
            connectBle(device)
        }
    }

    @SuppressLint("MissingPermission")
    private fun connectClassic(device: BluetoothDevice) {
        val uuid = UUID.fromString(SPP_UUID)
        readerThread = Thread {
            val socket = try {
                device.createRfcommSocketToServiceRecord(uuid)
            } catch (e: Exception) {
                postStatus(false, device.address, safeName(device), e.message)
                return@Thread
            }
            try {
                adapter?.cancelDiscovery()
                socket.connect()
                classicSocket = socket
                postStatus(true, device.address, safeName(device), null)
                val reader = socket.inputStream.bufferedReader()
                while (!Thread.currentThread().isInterrupted) {
                    val line = try {
                        reader.readLine()
                    } catch (e: IOException) {
                        null
                    } ?: break
                    mainHandler.post { onSentence(line) }
                }
            } catch (e: IOException) {
                postStatus(false, device.address, safeName(device), e.message)
            } finally {
                try { socket.close() } catch (_: IOException) { /* ignored */ }
                if (classicSocket === socket) classicSocket = null
                postStatus(false, device.address, safeName(device), null)
            }
        }.apply { isDaemon = true; start() }
    }

    @SuppressLint("MissingPermission")
    private fun connectBle(device: BluetoothDevice) {
        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    postStatus(false, device.address, safeName(device), null)
                    try { g.close() } catch (_: Throwable) { /* ignored */ }
                    if (gatt === g) gatt = null
                }
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                val service = g.services.firstOrNull { it.uuid == NUS_SERVICE } ?: run {
                    postStatus(false, device.address, safeName(device), "Nordic UART service not found")
                    g.disconnect()
                    return
                }
                val tx = service.characteristics.firstOrNull { it.uuid == NUS_TX_CHAR }
                if (tx == null) {
                    postStatus(false, device.address, safeName(device), "UART TX characteristic not found")
                    g.disconnect()
                    return
                }
                g.setCharacteristicNotification(tx, true)
                val cccd = tx.getDescriptor(CCCD_UUID)
                if (cccd != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                    } else {
                        @Suppress("DEPRECATION")
                        cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        @Suppress("DEPRECATION")
                        g.writeDescriptor(cccd)
                    }
                }
                postStatus(true, device.address, safeName(device), null)
            }

            // Kept for API < 33; deprecated but still required by the framework.
            @Deprecated("Use onCharacteristicChanged(Gatt, Char, ByteArray) on API 33+")
            @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
            override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                val bytes = characteristic.value ?: return
                feedBytes(bytes)
            }

            override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
                feedBytes(value)
            }
        }

        gatt = device.connectGatt(context, /* autoConnect= */ false, callback)
    }

    private val bleBuffer = StringBuilder()
    private fun feedBytes(bytes: ByteArray) {
        bleBuffer.append(String(bytes, Charsets.US_ASCII))
        while (true) {
            val nl = bleBuffer.indexOf('\n')
            if (nl < 0) break
            val sentence = bleBuffer.substring(0, nl).trimEnd('\r')
            bleBuffer.delete(0, nl + 1)
            if (sentence.isNotEmpty()) {
                mainHandler.post { onSentence(sentence) }
            }
        }
    }

    @SuppressLint("MissingPermission")
    fun disconnect() {
        try {
            classicSocket?.close()
        } catch (_: IOException) { /* ignored */ }
        classicSocket = null
        readerThread?.interrupt()
        readerThread = null

        try {
            gatt?.disconnect()
            gatt?.close()
        } catch (_: Throwable) { /* ignored */ }
        gatt = null

        postStatus(false, connectedDevice?.address, connectedDevice?.let { safeName(it) }, null)
        connectedDevice = null
    }

    fun connectedDeviceId(): String? = connectedDevice?.address
    fun connectedDeviceName(): String? = connectedDevice?.let { safeName(it) }
    fun isConnected(): Boolean = classicSocket != null || gatt != null

    // ---------------- helpers ----------------

    private fun postStatus(connected: Boolean, id: String?, name: String?, error: String?) {
        mainHandler.post { onStatus(connected, id, name, error) }
    }

    @SuppressLint("MissingPermission")
    private fun safeName(d: BluetoothDevice): String? = try { d.name } catch (_: SecurityException) { null }

    private fun hasBluetoothPermissions(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) ==
                PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }

    companion object {
        private const val TAG = "EgnssBtManager"
        private const val SPP_UUID = "00001101-0000-1000-8000-00805F9B34FB"
        private val NUS_SERVICE = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
        private val NUS_TX_CHAR = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
        private val CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")
    }
}
