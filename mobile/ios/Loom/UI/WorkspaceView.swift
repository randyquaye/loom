import SwiftUI

/// Infrastructure and model information is secondary to the conversation.
struct WorkspaceView: View {
    @Environment(AccountScope.self) private var scope
    let workspaceId: String
    var sessionId: String? = nil
    @State private var confirmStop = false

    var body: some View {
        Group {
            if let row = scope.workspace(workspaceId) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        DetailRow(title: "Workspace", value: row.name)
                        DetailRow(title: "Branch", value: row.branch)
                        let status = WorkspaceStatus(row, power: scope.power(of: row.id))
                        Label(status.text, systemImage: status.symbol)
                            .font(.subheadline).foregroundStyle(status.isProblem ? Color.red : LoomStyle.secondary)
                        if let access = row.sharedAccess { AccessBadge(access: access) }
                        if let id = sessionId, let session = scope.session(id), session.workspaceId == row.id {
                            Divider().padding(.vertical, 4)
                            DetailRow(title: "Session", value: session.title)
                            DetailRow(title: "Provider and model", value: "\(session.backend) · \(session.model)")
                            if !session.effort.isEmpty { DetailRow(title: "Reasoning effort", value: session.effort) }
                        }
                        if row.state == "error" {
                            Text("Setup did not finish. Open this workspace in Loom on your desktop to see the setup log.")
                                .font(.footnote).foregroundStyle(LoomStyle.secondary)
                        }
                        if row.sharedAccess == .view {
                            Text("Shared with you to view. You can read sessions and linked files; only people with control can act.")
                                .font(.footnote).foregroundStyle(LoomStyle.secondary)
                        }
                        if row.runtime == "container", !row.archived, scope.canControl(row.id) {
                            Divider().padding(.vertical, 4)
                            powerControl(row)
                        }
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .refreshable { await scope.loadSessions(workspaceId: workspaceId) }
            } else {
                ContentUnavailableView("Workspace unavailable", systemImage: "eye.slash",
                    description: Text("It was removed, or it is no longer shared with you."))
            }
        }
        .background(LoomStyle.canvas)
        .navigationTitle("Workspace details")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Stop this workspace?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop workspace", role: .destructive) { Task { await scope.setPower(workspaceId: workspaceId, running: false) } }
        } message: {
            Text("Agents and anything else running in it are interrupted. Files and sessions are kept.")
        }
    }

    @ViewBuilder private func powerControl(_ row: WorkspaceRow) -> some View {
        let power = scope.power(of: row.id)
        let busy = scope.isChangingPower(row.id) || power?.state == "starting" || power?.state == "stopping"
        let running = power?.state == "running" || power?.state == "stopping"
        HStack {
            Button(running ? "Stop workspace" : "Start workspace", role: running ? .destructive : nil) {
                if running { confirmStop = true } else { Task { await scope.setPower(workspaceId: row.id, running: true) } }
            }
            .frame(minHeight: 44)
            .disabled(!scope.canWrite(row.id) || busy || power == nil)
            Spacer()
            if busy { ProgressView() }
        }
        if let error = scope.actionError("power:\(row.id)") ?? power?.error {
            Text(error).font(.footnote).foregroundStyle(.red)
        }
    }
}
