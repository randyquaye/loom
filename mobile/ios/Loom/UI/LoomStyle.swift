import SwiftUI

/// Semantic surfaces shared by chat, history and secondary screens; colors follow system appearance.
enum LoomStyle {
    static let canvas = adaptive(light: 1, dark: 0.067)
    static let quiet = adaptive(light: 0.95, dark: 0.145)
    static let secondary = adaptive(light: 0.39, dark: 0.68)
    static let link = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.55, green: 0.73, blue: 1, alpha: 1)
            : UIColor(red: 0.082, green: 0.373, blue: 0.773, alpha: 1)
    })
    static let ink = Color.primary

    private static func adaptive(light: CGFloat, dark: CGFloat) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(white: traits.userInterfaceStyle == .dark ? dark : light, alpha: 1)
        })
    }
}

struct DetailRow: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.subheadline).foregroundStyle(LoomStyle.secondary)
            Text(value).font(.body).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}
