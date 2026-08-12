import UIKit
import Capacitor

/// Registers in-app plugins (HealthSync) that don't ship as pods.
/// Wired in via Main.storyboard's custom class.
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HealthSyncPlugin())
    }
}
