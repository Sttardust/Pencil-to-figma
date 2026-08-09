import AppKit
import Darwin
import Foundation

private let serviceLabel = "com.sttardust.pencil-figma-bridge"
private let bridgePort = 32145

@main
struct PencilFigmaBridgeApp {
    static func main() {
        let installer = BridgeInstaller()
        let quiet = CommandLine.arguments.contains("--quiet")
        do {
            if CommandLine.arguments.contains("--uninstall") {
                try installer.uninstall()
                if !quiet {
                    showMessage(
                        title: "Pencil Bridge removed",
                        message: "The background connection has been stopped and removed from Login Items."
                    )
                }
            } else {
                try installer.install()
                if !quiet {
                    showMessage(
                        title: "Pencil Bridge is ready",
                        message: "Open Pencil and then run the Pencil Bridge plugin in Figma. The bridge will start automatically when you sign in to this Mac."
                    )
                }
            }
        } catch {
            if quiet {
                FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            } else {
                showMessage(
                    title: "Pencil Bridge could not start",
                    message: error.localizedDescription,
                    isError: true
                )
            }
            exit(EXIT_FAILURE)
        }
    }
}

private struct BridgeInstaller {
    private let fileManager = FileManager.default
    private let userID = getuid()

    private var domain: String { "gui/\(userID)" }
    private var serviceTarget: String { "\(domain)/\(serviceLabel)" }
    private var home: URL { fileManager.homeDirectoryForCurrentUser }
    private var launchAgentsDirectory: URL {
        home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    }
    private var launchAgentURL: URL {
        launchAgentsDirectory.appendingPathComponent("\(serviceLabel).plist")
    }
    private var logsDirectory: URL {
        home.appendingPathComponent("Library/Logs/Pencil Figma Bridge", isDirectory: true)
    }
    private var resources: URL {
        get throws {
            guard let url = Bundle.main.resourceURL else {
                throw BridgeError("The application resources could not be located.")
            }
            return url
        }
    }

    func install() throws {
        let resources = try resources
        let nodeURL = resources.appendingPathComponent("runtime/node")
        let serviceURL = resources.appendingPathComponent("service/main.mjs")
        guard fileManager.isExecutableFile(atPath: nodeURL.path) else {
            throw BridgeError("The bundled runtime is missing or cannot be executed.")
        }
        guard fileManager.fileExists(atPath: serviceURL.path) else {
            throw BridgeError("The bundled bridge service is missing.")
        }

        try fileManager.createDirectory(
            at: launchAgentsDirectory,
            withIntermediateDirectories: true
        )
        try fileManager.createDirectory(
            at: logsDirectory,
            withIntermediateDirectories: true
        )
        try? runLaunchctl(["bootout", serviceTarget])

        let plist = renderLaunchAgent(
            nodePath: nodeURL.path,
            servicePath: serviceURL.path,
            workingDirectory: serviceURL.deletingLastPathComponent().path,
            stdoutPath: logsDirectory.appendingPathComponent("service.log").path,
            stderrPath: logsDirectory.appendingPathComponent("service-error.log").path
        )
        try plist.write(to: launchAgentURL, atomically: true, encoding: .utf8)
        guard chmod(launchAgentURL.path, S_IRUSR | S_IWUSR) == 0 else {
            throw BridgeError("The background service settings could not be secured.")
        }
        try bootstrap()
        try runLaunchctl(["kickstart", "-k", serviceTarget])
        try waitUntilReady()
    }

    func uninstall() throws {
        try? runLaunchctl(["bootout", serviceTarget])
        if fileManager.fileExists(atPath: launchAgentURL.path) {
            try fileManager.removeItem(at: launchAgentURL)
        }
    }

    private func runLaunchctl(_ arguments: [String]) throws {
        let process = Process()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let data = errors.fileHandleForReading.readDataToEndOfFile()
            let detail = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw BridgeError(detail?.isEmpty == false ? detail! : "launchctl failed with status \(process.terminationStatus).")
        }
    }

    private func bootstrap() throws {
        var lastError: Error?
        for attempt in 1...8 {
            do {
                try runLaunchctl(["bootstrap", domain, launchAgentURL.path])
                return
            } catch {
                lastError = error
                Thread.sleep(forTimeInterval: Double(attempt) * 0.25)
            }
        }
        throw lastError ?? BridgeError("The background connection could not be registered.")
    }

    private func waitUntilReady() throws {
        guard let url = URL(string: "http://127.0.0.1:\(bridgePort)/health") else {
            throw BridgeError("The bridge health address is invalid.")
        }
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if let data = try? Data(contentsOf: url),
               let text = String(data: data, encoding: .utf8),
               text.contains("\"ok\":true") {
                return
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        throw BridgeError(
            "The background connection did not become ready. Check ~/Library/Logs/Pencil Figma Bridge/service-error.log."
        )
    }

    private func renderLaunchAgent(
        nodePath: String,
        servicePath: String,
        workingDirectory: String,
        stdoutPath: String,
        stderrPath: String
    ) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(serviceLabel)</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(xml(nodePath))</string>
            <string>\(xml(servicePath))</string>
          </array>
          <key>WorkingDirectory</key>
          <string>\(xml(workingDirectory))</string>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
          <key>ProcessType</key>
          <string>Background</string>
          <key>ThrottleInterval</key>
          <integer>5</integer>
          <key>StandardOutPath</key>
          <string>\(xml(stdoutPath))</string>
          <key>StandardErrorPath</key>
          <string>\(xml(stderrPath))</string>
          <key>EnvironmentVariables</key>
          <dict>
            <key>NODE_ENV</key>
            <string>production</string>
          </dict>
        </dict>
        </plist>
        """
    }
}

private struct BridgeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private func xml(_ value: String) -> String {
    value
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "'", with: "&apos;")
}

private func showMessage(title: String, message: String, isError: Bool = false) {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = message
    alert.alertStyle = isError ? .critical : .informational
    alert.addButton(withTitle: "OK")
    alert.runModal()
}
