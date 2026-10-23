import Capacitor

// Capacitor's own view controller, with Quota's plugins added. Packaged plugins
// register themselves; one that lives in the app has to be handed over here.
class QuotaViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(QuotaPlugin())
        bridge?.registerPluginInstance(DualCamPlugin())
    }
}
