import SwiftUI
import WidgetKit

struct StreakEntry: TimelineEntry {
    let date: Date
    let snap: Snapshot

    // What the app last said is only about today if it said it today. After midnight the
    // new day has nothing posted yet, whatever yesterday looked like.
    var fresh: Bool { snap.day == dayString(date) }
    // A day the app has not been opened on yet: the week's pattern says whether it counts.
    var due: Bool {
        if fresh { return snap.due }
        let weekday = Calendar.current.component(.weekday, from: date) - 1
        return snap.dueDays.isEmpty || snap.dueDays.contains(weekday)
    }
    var done: Bool { fresh && snap.done }
    var late: Bool { snap.signedIn && due && !done && date >= lastCall(on: date) }
    var end: Date { midnight(after: date) }

    var status: String {
        if !snap.signedIn { return "Open Quota" }
        if !due { return "Rest day" }
        return done ? "Done today" : "Not posted yet"
    }
}

struct StreakProvider: TimelineProvider {
    func placeholder(in context: Context) -> StreakEntry {
        StreakEntry(date: Date(), snap: Snapshot(signedIn: true, streak: 12, day: dayString(Date())))
    }

    func getSnapshot(in context: Context, completion: @escaping (StreakEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : StreakEntry(date: Date(), snap: readSnapshot()))
    }

    // Three moments a day change what the widget says without the app saying anything:
    // now, the last call at 10:15pm, and midnight. The app reloads it whenever it knows more.
    func getTimeline(in context: Context, completion: @escaping (Timeline<StreakEntry>) -> Void) {
        let now = Date(), snap = readSnapshot(), end = midnight(after: now)
        var dates = [now]
        if lastCall(on: now) > now { dates.append(lastCall(on: now)) }
        dates.append(end)
        completion(Timeline(entries: dates.map { StreakEntry(date: $0, snap: snap) }, policy: .after(end.addingTimeInterval(60))))
    }
}

struct StreakWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: StreakEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular: circular
            case .accessoryRectangular: rectangular
            case .accessoryInline: inline
            default: small
            }
        }
        .widgetURL(URL(string: entry.late ? "hitquota://record" : "hitquota://open"))
    }

    var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 5) {
                Mark().frame(width: 13, height: 13)
                Text("Quota").font(.system(size: 13, weight: .semibold))
            }
            Spacer(minLength: 0)
            Text("\(entry.snap.streak)")
                .font(.system(size: 46, weight: .bold, design: .rounded))
                .foregroundStyle(entry.done ? quotaGreen : Color.primary)
                .minimumScaleFactor(0.5).lineLimit(1)
            Text("day streak").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
            Spacer(minLength: 6)
            if entry.late {
                HStack(spacing: 4) {
                    Text(timerInterval: entry.date...entry.end, countsDown: true).monospacedDigit()
                    Text("left")
                }
                .font(.system(size: 13, weight: .bold)).foregroundStyle(quotaWarn)
            } else {
                Text(entry.status)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(entry.done || !entry.due ? quotaGreen : quotaWarn)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetBackground(Color(UIColor.systemBackground))
    }

    var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            Circle().trim(from: 0, to: entry.done ? 1 : 0.0001)
                .rotation(.degrees(-90))
                .stroke(style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .padding(2)
            VStack(spacing: -2) {
                Text("\(entry.snap.streak)").font(.system(size: 20, weight: .bold, design: .rounded)).minimumScaleFactor(0.6)
                Text("days").font(.system(size: 10, weight: .medium))
            }
        }
        .widgetBackground(.clear)
    }

    var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(entry.snap.streak) day streak").font(.system(size: 15, weight: .bold))
            if entry.late {
                HStack(spacing: 3) {
                    Text(timerInterval: entry.date...entry.end, countsDown: true).monospacedDigit()
                    Text("left to post")
                }
                .font(.system(size: 13, weight: .medium))
            } else {
                Text(entry.status).font(.system(size: 13, weight: .medium))
            }
            if entry.late, !entry.snap.left.isEmpty {
                Text(entry.snap.left).font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetBackground(.clear)
    }

    var inline: some View {
        Text(entry.done ? "\(entry.snap.streak) day streak · done" : "\(entry.snap.streak) day streak · \(entry.status.lowercased())")
            .widgetBackground(.clear)
    }
}

struct StreakWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "QuotaStreak", provider: StreakProvider()) { entry in
            StreakWidgetView(entry: entry)
        }
        .configurationDisplayName("Streak")
        .description("Your streak, and whether today's proof is in.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
