import SwiftUI
import UIKit
import XCTest

/// Real SwiftUI laid out in a window of the test host app, for lifetimes only layout decides.
@MainActor
final class HostedWindow {
    let window: UIWindow
    var root: UIView { window.rootViewController!.view }

    init<Content: View>(_ content: Content, size: CGSize = CGSize(width: 390, height: 700)) throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = UIHostingController(rootView: content)
        window.makeKeyAndVisible()
        root.layoutIfNeeded()
    }

    func settle() async {
        for _ in 0..<10 {
            window.layoutIfNeeded()
            try? await Task.sleep(nanoseconds: 30_000_000)
        }
    }

    func scroll(to y: CGFloat) async throws {
        let scroll = try XCTUnwrap(Self.scrollView(in: root))
        scroll.setContentOffset(CGPoint(x: 0, y: min(y, max(0, scroll.contentSize.height - scroll.bounds.height))), animated: false)
        await settle()
    }

    func close() {
        window.isHidden = true
        window.rootViewController = nil
    }

    private static func scrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView { return scroll }
        for child in view.subviews { if let found = scrollView(in: child) { return found } }
        return nil
    }
}

/// A view whose own `@State` object counts itself, so a test can see when that state is released.
struct LifetimeProbe: View {
    final class Witness {
        static let alive = Locked(0)
        init() { Self.alive.update { $0 += 1 } }
        deinit { Self.alive.update { $0 -= 1 } }
    }

    @State private var witness = Witness()

    var body: some View { Text("probe") }
}
