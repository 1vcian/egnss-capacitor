import Foundation
import CoreLocation

/// Internal GNSS wrapper for iOS based on `CLLocationManager`.
///
/// iOS does not expose raw GNSS measurements or OSNMA data to third-party
/// apps; the only hook we have is `CLLocation` which carries processed
/// lat/lon/accuracy. This class therefore keeps the interface minimal and
/// relies on the Bluetooth path ([BluetoothService]) for richer data.
final class GnssService: NSObject, CLLocationManagerDelegate {
    struct OutFix {
        let lat: Double
        let lon: Double
        let alt: Double
        let hAccuracy: Double
        let vAccuracy: Double
        let timestamp: TimeInterval
        let speed: Double?
        let bearing: Double?
        let isMockLocation: Bool
    }

    var onFix: ((OutFix) -> Void)?
    var onError: ((String) -> Void)?

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
    }

    /// Request "when in use" permission. The app bundle must declare
    /// `NSLocationWhenInUseUsageDescription` in its Info.plist.
    func requestPermission() {
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
    }

    func authorizationStatus() -> String {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: return "granted"
        case .denied, .restricted: return "denied"
        default: return "prompt"
        }
    }

    func start() {
        manager.startUpdatingLocation()
        manager.startUpdatingHeading()
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        // `sourceInformation.isSimulatedBySoftware` exists on iOS 15+; older
        // versions fall back to `false`.
        var isMock = false
        if #available(iOS 15.0, *) {
            isMock = loc.sourceInformation?.isSimulatedBySoftware ?? false
        }
        onFix?(OutFix(
            lat: loc.coordinate.latitude,
            lon: loc.coordinate.longitude,
            alt: loc.altitude,
            hAccuracy: loc.horizontalAccuracy,
            vAccuracy: loc.verticalAccuracy >= 0 ? loc.verticalAccuracy : 0,
            timestamp: loc.timestamp.timeIntervalSince1970,
            speed: loc.speed >= 0 ? loc.speed : nil,
            bearing: loc.course >= 0 ? loc.course : nil,
            isMockLocation: isMock
        ))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        onError?(error.localizedDescription)
    }
}
