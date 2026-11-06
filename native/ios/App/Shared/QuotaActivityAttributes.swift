import Foundation
#if canImport(ActivityKit)
import ActivityKit

// What the end-of-day countdown knows. The app starts it and the widget extension draws
// it, so this one file is compiled into both. Plain numbers and strings only, because a
// push from the server will fill the same thing in once Apple's push key exists.
@available(iOS 16.1, *)
struct QuotaActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var streak: Int
        var left: String
        var crew: String
        var done: Bool
        // What the streak counts: "day", or "week", "month" or "year" for a group that is not
        // judged a day at a time. Last, with a default, so everything that made one before
        // still makes one the same way.
        var unit: String = "day"
    }
    // Midnight where the person is, in seconds since 1970.
    var deadline: Double
    var deadlineDate: Date { Date(timeIntervalSince1970: deadline) }
}
#endif
