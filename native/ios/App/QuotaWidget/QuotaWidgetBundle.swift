import SwiftUI
import WidgetKit

@main
struct QuotaWidgetBundle: WidgetBundle {
    var body: some Widget {
        StreakWidget()
        MotivationWidget()
        CountdownWidget()
        if #available(iOS 16.2, *) {
            QuotaLiveActivity()
        }
    }
}
