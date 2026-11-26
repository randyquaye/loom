import SwiftUI

struct SignInView: View {
    @Environment(AppStore.self) private var store
    @State private var email = ""
    @State private var host = ""
    @FocusState private var focus: Field?

    private enum Field {
        case email
        case host
    }

    private var isWorking: Bool {
        if case .working = store.signInStatus { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text("Loom").font(.subheadline.weight(.medium))
                    Text("Connect to your workspaces").font(.largeTitle.weight(.semibold))
                    Text("Use your work email and your organization’s Loom address.")
                        .font(.body).foregroundStyle(LoomStyle.secondary)
                    if let notice = store.notice {
                        Label(notice, systemImage: "info.circle").font(.subheadline).foregroundStyle(LoomStyle.secondary)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Work email").font(.subheadline.weight(.medium))
                        TextField("you@example.com", text: $email)
                            .textContentType(.emailAddress).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .submitLabel(.next).focused($focus, equals: .email)
                            .onSubmit { focus = .host }
                            .padding(16).frame(minHeight: 56)
                            .background(LoomStyle.quiet, in: RoundedRectangle(cornerRadius: 14))
                            .accessibilityLabel("Work email")
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Organization address").font(.subheadline.weight(.medium))
                        TextField("loom.example.com", text: $host)
                            .textContentType(.URL).keyboardType(.URL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .submitLabel(.go).focused($focus, equals: .host).onSubmit(start)
                            .padding(16).frame(minHeight: 56)
                            .background(LoomStyle.quiet, in: RoundedRectangle(cornerRadius: 14))
                            .accessibilityLabel("Organization host")
                    }
                    Button(action: start) {
                        HStack {
                            Spacer()
                            if isWorking { ProgressView().padding(.trailing, 6) }
                            Text(isWorking ? "Signing in…" : "Sign in with Google").fontWeight(.medium)
                            Spacer()
                        }.frame(minHeight: 48)
                    }
                    .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                    .disabled(isWorking || email.isEmpty || host.isEmpty)
                    Group {
                        switch store.signInStatus {
                        case .idle:
                            Text("Sign-in opens in your browser. You must already belong to the organization.")
                                .foregroundStyle(LoomStyle.secondary)
                        case .working(let message): Text(message).foregroundStyle(LoomStyle.secondary)
                        case .failed(let message):
                            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                                .accessibilityLabel("Sign-in failed. \(message)")
                        }
                    }.font(.footnote)
                }
                .padding(.horizontal, 24).padding(.vertical, 48)
                .frame(maxWidth: 520, alignment: .leading).frame(maxWidth: .infinity)
            }
            .background(LoomStyle.canvas)
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func start() {
        focus = nil
        store.signIn(email: email, host: host)
    }
}
