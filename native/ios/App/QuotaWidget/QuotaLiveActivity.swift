import ActivityKit
import SwiftUI
import WidgetKit

// The end-of-day countdown: on the lock screen and in the Dynamic Island from 10:15pm until
// today's proof is in. The clock counts down on its own; nothing has to update it.
@available(iOS 16.2, *)
struct QuotaLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: QuotaActivityAttributes.self) { context in
            LockScreenCountdown(context: context)
                .activityBackgroundTint(Color.black.opacity(0.82))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "hitquota://record"))
        } dynamicIsland: { context in
            let end = context.attributes.deadlineDate
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Mark().frame(width: 16, height: 16)
                        Text(context.state.streak > 0 ? "\(context.state.streak) day streak" : "Day one")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Countdown(end: end, done: context.state.done)
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(quotaWarn)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        if !context.state.left.isEmpty {
                            Text(context.state.left).font(.system(size: 13)).foregroundStyle(.secondary)
                        }
                        if !context.state.done {
                            Link(destination: URL(string: "hitquota://record")!) {
                                Text("Record now")
                                    .font(.system(size: 15, weight: .semibold))
                                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                                    .background(quotaGreen, in: RoundedRectangle(cornerRadius: 12))
                                    .foregroundStyle(.white)
                            }
                        }
                    }
                }
            } compactLeading: {
                Mark().frame(width: 16, height: 16).padding(.leading, 2)
            } compactTrailing: {
                Countdown(end: end, done: context.state.done)
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(quotaWarn)
                    .frame(minWidth: 60, maxWidth: 72)
            } minimal: {
                Mark().frame(width: 16, height: 16)
            }
            .widgetURL(URL(string: "hitquota://record"))
        }
    }
}

// A live countdown to midnight, or a tick once it is done. Never handed a range that ends
// before it starts, which is the one way Text(timerInterval:) crashes.
struct Countdown: View {
    let end: Date
    let done: Bool
    var body: some View {
        if done {
            Image(systemName: "checkmark")
        } else if end <= Date() {
            Text("0:00")
        } else {
            Text(timerInterval: Date()...end, countsDown: true).monospacedDigit().multilineTextAlignment(.trailing)
        }
    }
}

@available(iOS 16.2, *)
struct LockScreenCountdown: View {
    let context: ActivityViewContext<QuotaActivityAttributes>

    var body: some View {
        let state = context.state, end = context.attributes.deadlineDate
        let start = end.addingTimeInterval(-105 * 60)
        let over = context.isStale || end <= Date()
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                HStack(spacing: 6) {
                    Mark().frame(width: 14, height: 14)
                    Text("Quota").font(.system(size: 14, weight: .semibold))
                }
                Spacer()
                Text(headline(state, over: over))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(state.done ? quotaBright : quotaWarn)
            }
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.done ? "Done for today" : over ? "Today's over" : "Left to post")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.65))
                    Countdown(end: end, done: state.done)
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    if !state.left.isEmpty { Text(state.left) }
                    if !state.crew.isEmpty { Text(state.crew) }
                }
                .font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.65))
                .multilineTextAlignment(.trailing)
            }
            if !state.done, !over, start < end {
                ProgressView(timerInterval: start...end, countsDown: true) { EmptyView() } currentValueLabel: { EmptyView() }
                    .tint(quotaBright)
            }
        }
        .padding(16)
        .foregroundStyle(.white)
    }

    func headline(_ state: QuotaActivityAttributes.ContentState, over: Bool) -> String {
        if state.done { return "\(state.streak) day streak" }
        if over { return "Streak missed" }
        return state.streak > 0 ? "\(state.streak) day streak at risk" : "Start your streak"
    }
}
