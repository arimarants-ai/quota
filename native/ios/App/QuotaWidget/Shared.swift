import SwiftUI
import WidgetKit

// The app and the widgets share one App Group. The app writes what the home screen says
// about today into it every time it loads; the widgets only ever read.
let appGroup = "group.app.hitquota.quota"
let quotaGreen = Color(red: 11 / 255, green: 90 / 255, blue: 52 / 255)
let quotaBright = Color(red: 34 / 255, green: 197 / 255, blue: 94 / 255)
let quotaWarn = Color(red: 251 / 255, green: 146 / 255, blue: 60 / 255)

struct Snapshot: Codable {
    var signedIn = false
    var streak = 0
    var day = ""        // yyyy-MM-dd the app wrote this on, in the person's own time
    var due = true      // a quota is expected today (not a rest day)
    var done = false
    var left = ""       // "50 pushups"
    var crew = ""       // "Sam and Maya are done"
    var dueDays: [Int] = []   // weekdays anything is expected, 0 is Sunday
    var unit = "day"    // what the streak counts: "day", or "week", "month" or "year"
    // Newer than the first widgets. An app from before them sends none of these, and the
    // widgets then draw the way they always did; nil is how they tell.
    var posted: Bool? = nil     // anything posted towards any group today, a 0 included
    var cdLeft: Int? = nil      // the Countdown widget: how much of the first short quota is left (0: nothing owed)
    var cdMetric = ""           // "pushups"
    var cdGroup = ""            // "Mornings"
    var cdPct: Double = 0       // how far in, 0 to 1

    init(signedIn: Bool = false, streak: Int = 0, day: String = "", posted: Bool? = nil) {
        self.signedIn = signedIn; self.streak = streak; self.day = day; self.posted = posted
    }

    // Every key optional: signed out sends almost nothing, and an older app sends fewer.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        signedIn = try c.decodeIfPresent(Bool.self, forKey: .signedIn) ?? false
        streak = try c.decodeIfPresent(Int.self, forKey: .streak) ?? 0
        day = try c.decodeIfPresent(String.self, forKey: .day) ?? ""
        due = try c.decodeIfPresent(Bool.self, forKey: .due) ?? true
        done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
        left = try c.decodeIfPresent(String.self, forKey: .left) ?? ""
        crew = try c.decodeIfPresent(String.self, forKey: .crew) ?? ""
        dueDays = try c.decodeIfPresent([Int].self, forKey: .dueDays) ?? []
        unit = try c.decodeIfPresent(String.self, forKey: .unit) ?? "day"
        posted = try c.decodeIfPresent(Bool.self, forKey: .posted)
        cdLeft = try c.decodeIfPresent(Int.self, forKey: .cdLeft)
        cdMetric = try c.decodeIfPresent(String.self, forKey: .cdMetric) ?? ""
        cdGroup = try c.decodeIfPresent(String.self, forKey: .cdGroup) ?? ""
        cdPct = min(1, max(0, try c.decodeIfPresent(Double.self, forKey: .cdPct) ?? 0))
    }
}

func readSnapshot() -> Snapshot {
    guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: "widget"),
          let snap = try? JSONDecoder().decode(Snapshot.self, from: data) else { return Snapshot() }
    return snap
}

func dayString(_ date: Date) -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: date)
}

func midnight(after date: Date) -> Date {
    let cal = Calendar.current
    return cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: date)) ?? date.addingTimeInterval(86_400)
}

// When the last call starts: an hour and three quarters before midnight. The lock screen
// widgets, the Live Activity and the notification still go by this one.
func lastCall(on date: Date) -> Date {
    Calendar.current.date(bySettingHour: 22, minute: 15, second: 0, of: date) ?? date
}

// When the Streak widget turns to its last hours: 8pm, four hours before midnight.
func lastHours(on date: Date) -> Date {
    Calendar.current.date(bySettingHour: 20, minute: 0, second: 0, of: date) ?? date
}

// The line of the day, and which of the fourteen pictures goes with it: the same for
// everybody on the same date, all fourteen in turn. The page works it out the same way
// (lineOfDay in index.html): the local date's day number since 1 January 1970, mod 14.
let motivationLines = [
    "Consistency is key.", "Crush the day.", "Proof or it didn't happen.", "Today counts.", "One post. That's all.",
    "Your crew's watching.", "Small reps, big streak.", "Show up today.", "Done beats perfect.", "Future you says thanks.",
    "Easy day? Still counts.", "Keep it rolling.", "Breathe. Then go.", "You vs. yesterday.",
]

func motivationIndex(_ date: Date) -> Int {
    let d = Calendar.current.dateComponents([.year, .month, .day], from: date)
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC") ?? .current
    let start = utc.date(from: DateComponents(year: d.year, month: d.month, day: d.day)) ?? date
    let n = Int(floor(start.timeIntervalSince1970 / 86_400))
    return ((n % 14) + 14) % 14
}

func motivationLine(_ date: Date) -> String { motivationLines[motivationIndex(date)] }

// "MascotMotivation01" to "MascotMotivation14".
func motivationArt(_ date: Date) -> String { String(format: "MascotMotivation%02d", motivationIndex(date) + 1) }

// Dark text on the light art and white on the dark, which is the one the system picks.
func inkColor(_ scheme: ColorScheme) -> Color { scheme == .dark ? .white : Color(red: 11 / 255, green: 12 / 255, blue: 14 / 255) }
func doneColor(_ scheme: ColorScheme) -> Color { scheme == .dark ? quotaBright : quotaGreen }

// The Quota ring, drawn rather than shipped as an image so it is sharp at every size.
struct Mark: View {
    var color = quotaBright
    var body: some View {
        GeometryReader { geo in
            Circle()
                .trim(from: 0.08, to: 0.92)
                .rotation(.degrees(-60))
                .stroke(color, style: StrokeStyle(lineWidth: max(2, geo.size.width * 0.2), lineCap: .round))
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

extension View {
    // iOS 17 asks every widget for a background; iOS 16 has no such modifier.
    @ViewBuilder func widgetBackground(_ color: Color) -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(for: .widget) { color }
        } else {
            background(color)
        }
    }

    // A picture from the widget's asset catalog, filling the whole widget behind the words.
    // Only the one named is loaded. iOS 16 gives a widget no margins of its own, so the words
    // get them here.
    @ViewBuilder func widgetArt(_ name: String) -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(for: .widget) { Image(name).resizable().scaledToFill() }
        } else {
            padding(16).background(Image(name).resizable().scaledToFill())
        }
    }
}
