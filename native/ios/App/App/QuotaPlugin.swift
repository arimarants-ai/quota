import Foundation
import Capacitor
import WidgetKit
#if canImport(ActivityKit)
import ActivityKit
#endif

// What the page tells the phone about today, for the parts of Quota that live outside the
// app: the streak widgets, and the countdown on the lock screen. The page works out every
// number; this only stores it where the widgets can read it, or hands it to ActivityKit.
@objc(QuotaPlugin)
public class QuotaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QuotaPlugin"
    public let jsName = "Quota"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setWidget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startCountdown", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endCountdown", returnType: CAPPluginReturnPromise),
    ]
    static let group = "group.app.hitquota.quota"

    @objc func setWidget(_ call: CAPPluginCall) {
        let data = try? JSONSerialization.data(withJSONObject: call.options ?? [:])
        UserDefaults(suiteName: Self.group)?.set(data, forKey: "widget")
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    // Started, or brought up to date if one is already running for the same midnight. One
    // from an earlier day is ended first: there is only ever today's.
    @objc func startCountdown(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { return call.resolve(["started": false, "reason": "old iOS"]) }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return call.resolve(["started": false, "reason": "off"]) }
        let deadline = call.getDouble("deadline") ?? 0
        let state = QuotaActivityAttributes.ContentState(
            streak: call.getInt("streak") ?? 0, left: call.getString("left") ?? "",
            crew: call.getString("crew") ?? "", done: false)
        let content = ActivityContent(state: state, staleDate: Date(timeIntervalSince1970: deadline))
        Task {
            let running = Activity<QuotaActivityAttributes>.activities
            for old in running where old.attributes.deadline != deadline {
                await old.end(nil, dismissalPolicy: .immediate)
            }
            if let current = running.first(where: { $0.attributes.deadline == deadline }) {
                await current.update(content)
                return call.resolve(["started": true, "updated": true])
            }
            do {
                _ = try Activity.request(attributes: QuotaActivityAttributes(deadline: deadline), content: content, pushType: nil)
                call.resolve(["started": true])
            } catch {
                call.resolve(["started": false, "reason": error.localizedDescription])
            }
        }
    }

    // Done: it says so for a few minutes and then goes. Not needed any more (a rest day, a
    // new day, signed out): it goes at once.
    @objc func endCountdown(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { return call.resolve() }
        let done = call.getBool("done") ?? false
        Task {
            for activity in Activity<QuotaActivityAttributes>.activities {
                var state = activity.content.state
                state.done = done
                if let streak = call.getInt("streak") { state.streak = streak }
                await activity.end(ActivityContent(state: state, staleDate: nil),
                                   dismissalPolicy: done ? .after(Date().addingTimeInterval(10 * 60)) : .immediate)
            }
            call.resolve()
        }
    }
}
