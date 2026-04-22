import Foundation
import CoreBluetooth

/**
 * External Bluetooth GNSS antenna adapter for iOS, using CoreBluetooth.
 *
 * iOS only supports BLE for third-party apps (classic Bluetooth / SPP
 * requires MFi certification per device). We target the two profiles
 * most BLE GNSS receivers expose:
 *
 *   - Nordic UART Service (NUS) — `6E400001-...-24DCCA9E`
 *   - Bad Elf / SparkFun custom UART — discovered via characteristic scan.
 *
 * The service picks the first notify-capable characteristic it finds on
 * the connected peripheral and assumes it streams NMEA sentences in UTF-8,
 * which matches every consumer GNSS receiver we have encountered.
 */
final class BluetoothService: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {

    struct Device {
        let id: String
        let name: String
        let rssi: Int?
    }

    // Callbacks (set by the plugin).
    var onSentence: ((String) -> Void)?
    var onStatus: ((_ connected: Bool, _ device: Device?, _ error: String?) -> Void)?
    var onScanResult: ((Device) -> Void)?
    var onScanFinished: (() -> Void)?

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var notifyChar: CBCharacteristic?
    private var carry = ""
    private var scanEndTimer: Timer?
    private var pendingScan = false
    private var discovered: [String: CBPeripheral] = [:]

    // Well-known Nordic UART service + TX characteristic.
    private let NUS_SERVICE = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    private let NUS_TX_CHAR = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E")

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
    }

    func isAvailable() -> Bool { central.state == .poweredOn }

    // MARK: - Scan

    func startScan(timeoutMs: Int) {
        guard central.state == .poweredOn else {
            pendingScan = true
            return
        }
        discovered.removeAll()
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        scanEndTimer?.invalidate()
        scanEndTimer = Timer.scheduledTimer(withTimeInterval: Double(timeoutMs) / 1000.0, repeats: false) { [weak self] _ in
            self?.stopScan()
        }
    }

    func stopScan() {
        let wasScanning = central.isScanning || scanEndTimer != nil
        if central.isScanning { central.stopScan() }
        scanEndTimer?.invalidate()
        scanEndTimer = nil
        if wasScanning { onScanFinished?() }
    }

    // MARK: - Connect

    func connect(deviceId: String) {
        guard central.state == .poweredOn else {
            onStatus?(false, nil, "Bluetooth not powered on")
            return
        }
        if let p = discovered[deviceId] {
            peripheral = p
            p.delegate = self
            central.connect(p)
            return
        }
        // Try to retrieve the peripheral from the system cache (possible after
        // a previous successful connection).
        if let uuid = UUID(uuidString: deviceId) {
            let retrieved = central.retrievePeripherals(withIdentifiers: [uuid])
            if let p = retrieved.first {
                peripheral = p
                p.delegate = self
                central.connect(p)
                return
            }
        }
        onStatus?(false, nil, "Device not found. Scan first.")
    }

    func disconnect() {
        if let p = peripheral {
            central.cancelPeripheralConnection(p)
        }
        notifyChar = nil
        peripheral = nil
        carry = ""
    }

    func connectedDevice() -> Device? {
        guard let p = peripheral, p.state == .connected else { return nil }
        return Device(id: p.identifier.uuidString, name: p.name ?? "GNSS device", rssi: nil)
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn, pendingScan {
            pendingScan = false
            startScan(timeoutMs: 8000)
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        discovered[peripheral.identifier.uuidString] = peripheral
        onScanResult?(Device(
            id: peripheral.identifier.uuidString,
            name: peripheral.name ?? "Unknown GNSS device",
            rssi: RSSI.intValue
        ))
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.delegate = self
        // Discover all services; we pick the first one that has a notify-capable characteristic.
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        onStatus?(false, nil, error?.localizedDescription ?? "Failed to connect")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        onStatus?(false, Device(id: peripheral.identifier.uuidString, name: peripheral.name ?? "GNSS device", rssi: nil),
                  error?.localizedDescription)
        notifyChar = nil
        self.peripheral = nil
        carry = ""
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let services = peripheral.services else {
            onStatus?(false, nil, error?.localizedDescription ?? "Service discovery failed")
            return
        }
        for service in services {
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil, let chars = service.characteristics else { return }
        for c in chars where c.properties.contains(.notify) && notifyChar == nil {
            notifyChar = c
            peripheral.setNotifyValue(true, for: c)
            onStatus?(true,
                      Device(id: peripheral.identifier.uuidString,
                             name: peripheral.name ?? "GNSS device",
                             rssi: nil),
                      nil)
            break
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let data = characteristic.value else { return }
        guard let chunk = String(data: data, encoding: .utf8) else { return }
        // Buffer until a newline; emit sentence-by-sentence so downstream code
        // can stay synchronous and assumption-free.
        carry += chunk
        while let nl = carry.firstIndex(where: { $0 == "\n" }) {
            let sentence = String(carry[..<nl]).trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
            carry.removeSubrange(...nl)
            if !sentence.isEmpty {
                onSentence?(sentence)
            }
        }
    }
}
