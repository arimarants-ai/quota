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

    init(signedIn: Bool = false, streak: Int = 0, day: String = "") {
        self.signedIn = signedIn; self.streak = streak; self.day = day
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

// When the last call starts: an hour and three quarters before midnight.
func lastCall(on date: Date) -> Date {
    Calendar.current.date(bySettingHour: 22, minute: 15, second: 0, of: date) ?? date
}

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
}
