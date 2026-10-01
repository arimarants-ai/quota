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
    }
    // Midnight where the person is, in seconds since 1970.
    var deadline: Double
    var deadlineDate: Date { Date(timeIntervalSince1970: deadline) }
}
#endif
