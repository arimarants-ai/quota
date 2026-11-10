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

    // ---- the four moments (the home screen widget, with the art)
    // nil: the app that wrote this is older than the moments, so the widget draws the old way.
    var hasMoments: Bool { snap.posted != nil }
    var posted: Bool { fresh && (snap.posted ?? false) }
    // From 8pm on a day still owed, the time left counts down.
    var lastHoursNow: Bool { snap.signedIn && due && !done && date >= lastHours(on: date) }
    enum Moment { case signedOut, morning, partway, lastHours, done, rest }
    var moment: Moment {
        if !snap.signedIn { return .signedOut }
        if done { return .done }
        if !due { return .rest }
        if lastHoursNow { return .lastHours }
        return posted ? .partway : .morning
    }
    var art: String {
        switch moment {
        case .partway: return "MascotPartway"
        case .lastHours: return "MascotLastHours"
        case .done, .rest: return "MascotDone"
        case .morning, .signedOut: return "MascotMorning"
        }
    }

    var status: String {
        if !snap.signedIn { return "Open Quota" }
        if !due { return "Rest day" }
        return done ? "Done today" : "Not posted yet"
    }
}

struct StreakProvider: TimelineProvider {
    func placeholder(in context: Context) -> StreakEntry {
        StreakEntry(date: Date(), snap: Snapshot(signedIn: true, streak: 12, day: dayString(Date()), posted: false))
    }

    func getSnapshot(in context: Context, completion: @escaping (StreakEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : StreakEntry(date: Date(), snap: readSnapshot()))
    }

    // Four moments a day change what the widget says without the app saying anything: now,
    // the last hours at 8pm, the last call at 10:15pm (the lock screen's), and midnight. The
    // app reloads it whenever it knows more.
    func getTimeline(in context: Context, completion: @escaping (Timeline<StreakEntry>) -> Void) {
        let now = Date(), snap = readSnapshot(), end = midnight(after: now)
        var dates = [now]
        if lastHours(on: now) > now { dates.append(lastHours(on: now)) }
        if lastCall(on: now) > now { dates.append(lastCall(on: now)) }
        dates.append(end)
        completion(Timeline(entries: dates.map { StreakEntry(date: $0, snap: snap) }, policy: .after(end.addingTimeInterval(60))))
    }
}

struct StreakWidgetView: View {
    @Environment(\.widgetFamily) var family
    @Environment(\.colorScheme) var scheme
    let entry: StreakEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular: circular
            case .accessoryRectangular: rectangular
            case .accessoryInline: inline
            default: if entry.hasMoments { moments } else { small }
            }
        }
        .widgetURL(URL(string: tapRecords ? "hitquota://record" : "hitquota://open"))
    }

    // The home screen one goes to recording from its last hours; the lock screen ones, and
    // the old one, from the last call, as before.
    var tapRecords: Bool {
        switch family {
        case .accessoryCircular, .accessoryRectangular, .accessoryInline: return entry.late
        default: return entry.hasMoments ? entry.moment == .lastHours : entry.late
        }
    }

    // The art fills the widget: the number at the top left, the line at the bottom left.
    // No name and no ring: the mascot is the brand.
    var moments: some View {
        let ink = inkColor(scheme)
        return VStack(alignment: .leading, spacing: 0) {
            if entry.moment != .signedOut {
                Text("\(entry.snap.streak)")
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .foregroundStyle(entry.moment == .done ? doneColor(scheme) : ink)
                    .minimumScaleFactor(0.5).lineLimit(1)
                Text("\(entry.snap.unit) streak").font(.system(size: 13, weight: .semibold)).foregroundStyle(ink.opacity(0.75))
            }
            Spacer(minLength: 4)
            line(ink)
                .font(.system(size: 13, weight: .bold))
                .lineLimit(2).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetArt(entry.art)
    }

    @ViewBuilder func line(_ ink: Color) -> some View {
        switch entry.moment {
        case .signedOut: Text("Open Quota").foregroundStyle(ink)
        case .morning: Text(motivationLine(entry.date)).foregroundStyle(ink)
        case .partway: Text(entry.snap.left.isEmpty ? "Not done yet" : "\(entry.snap.left) left today").foregroundStyle(ink)
        case .lastHours:
            HStack(spacing: 4) {
                Text(timerInterval: entry.date...entry.end, countsDown: true).monospacedDigit()
                Text("left")
            }
            .foregroundStyle(ink)
        case .done: Text("Done today").foregroundStyle(doneColor(scheme))
        case .rest: Text("Rest day").foregroundStyle(ink)
        }
    }

    // How the home screen widget looked before the art, for a snapshot from an older app.
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
            Text("\(entry.snap.unit) streak").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
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
            Text("\(entry.snap.streak) \(entry.snap.unit) streak").font(.system(size: 15, weight: .bold))
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
        Text(entry.done ? "\(entry.snap.streak) \(entry.snap.unit) streak · done" : "\(entry.snap.streak) \(entry.snap.unit) streak · \(entry.status.lowercased())")
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

// ---- Motivation: one picture and its line a day, all fourteen in turn
// Changes only at midnight, so its timeline is now and midnight and nothing in between.
struct DayProvider: TimelineProvider {
    func placeholder(in context: Context) -> StreakEntry {
        StreakEntry(date: Date(), snap: Snapshot(signedIn: true, streak: 12, day: dayString(Date()), posted: false))
    }

    func getSnapshot(in context: Context, completion: @escaping (StreakEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : StreakEntry(date: Date(), snap: readSnapshot()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StreakEntry>) -> Void) {
        let now = Date(), snap = readSnapshot(), end = midnight(after: now)
        completion(Timeline(entries: [StreakEntry(date: now, snap: snap), StreakEntry(date: end, snap: snap)],
                            policy: .after(end.addingTimeInterval(60))))
    }
}

struct MotivationWidgetView: View {
    @Environment(\.colorScheme) var scheme
    let entry: StreakEntry

    var body: some View {
        let ink = inkColor(scheme)
        return VStack(alignment: .leading, spacing: 2) {
            Spacer(minLength: 0)
            Text(motivationLine(entry.date))
                .font(.system(size: 15, weight: .bold)).foregroundStyle(ink)
                .lineLimit(2).minimumScaleFactor(0.8)
            if entry.snap.signedIn {
                Text("\(entry.snap.streak) \(entry.snap.unit) streak")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(ink.opacity(0.75))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetArt(motivationArt(entry.date))
        .widgetURL(URL(string: "hitquota://open"))
    }
}

struct MotivationWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "QuotaMotivation", provider: DayProvider()) { entry in
            MotivationWidgetView(entry: entry)
        }
        .configurationDisplayName("Motivation")
        .description("A new line every day, and your streak under it.")
        .supportedFamilies([.systemSmall])
    }
}

// ---- Countdown: what is left today, and the time left to do it in
// No art. The clock runs on its own; the timeline only has to turn the day over.
struct CountdownWidgetView: View {
    let entry: StreakEntry

    // Something still owed today, by the app's last word on it. An app from before this sends
    // no number, and then the line the Streak widget shows stands in for it.
    var owed: Bool { entry.snap.signedIn && entry.due && !(entry.fresh && entry.snap.cdLeft == 0) && !(entry.done && entry.snap.cdLeft == nil) }
    var big: String {
        guard entry.fresh else { return "Not posted yet" }
        if let n = entry.snap.cdLeft, n > 0 { return "\(n) left" }
        return entry.snap.left.isEmpty ? "Not posted yet" : "\(entry.snap.left) left"
    }
    var under: String {
        guard entry.fresh, entry.snap.cdLeft != nil else { return "" }
        return [entry.snap.cdMetric, entry.snap.cdGroup].filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !entry.snap.signedIn {
                Spacer(minLength: 0)
                Text("Open Quota").font(.system(size: 17, weight: .bold))
            } else if !entry.due {
                Spacer(minLength: 0)
                Text("Rest day").font(.system(size: 22, weight: .bold, design: .rounded)).foregroundStyle(quotaGreen)
            } else if !owed {
                Spacer(minLength: 0)
                Text("Done today").font(.system(size: 22, weight: .bold, design: .rounded)).foregroundStyle(quotaGreen)
                Text("\(entry.snap.streak) \(entry.snap.unit) streak").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
            } else {
                Text(big).font(.system(size: 26, weight: .bold, design: .rounded)).lineLimit(1).minimumScaleFactor(0.5)
                if !under.isEmpty {
                    Text(under).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
                }
                if entry.fresh && entry.snap.cdLeft != nil {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.primary.opacity(0.1))
                            Capsule().fill(quotaBright).frame(width: max(6, geo.size.width * CGFloat(entry.snap.cdPct)))
                        }
                    }
                    .frame(height: 6)
                    .padding(.top, 4)
                }
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    Text(timerInterval: entry.date...entry.end, countsDown: true).monospacedDigit()
                    Text("left")
                }
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(entry.lastHoursNow ? quotaWarn : Color.primary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetBackground(Color(UIColor.systemBackground))
        .widgetURL(URL(string: owed ? "hitquota://record" : "hitquota://open"))
    }
}

struct CountdownWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "QuotaCountdown", provider: StreakProvider()) { entry in
            CountdownWidgetView(entry: entry)
        }
        .configurationDisplayName("Countdown")
        .description("What is left today, and the time left to do it.")
        .supportedFamilies([.systemSmall])
    }
}
