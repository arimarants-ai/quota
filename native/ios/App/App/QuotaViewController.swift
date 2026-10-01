import Capacitor

// Capacitor's own view controller, with Quota's plugin added. Plugins that ship as packages
// register themselves; one that lives in the app has to be handed over here.
class QuotaViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(QuotaPlugin())
    }
}
