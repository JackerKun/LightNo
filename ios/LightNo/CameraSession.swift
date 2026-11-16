import AVFoundation
import CoreImage
import Foundation
import ImageIO

/// Delivers a video frame only when the UI is ready for it. No still photo or file output.
final class CameraSession: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    typealias Event = [String: Any]

    private let queue = DispatchQueue(label: "LightNo.camera", qos: .userInitiated)
    private let captureSession = AVCaptureSession()
    private let context = CIContext()
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    private let publish: (Event) -> Void
    private var device: AVCaptureDevice?
    private var stream: Int?
    private var wantsFrame = false
    private var requestedFPS = 10
    private var deliveryFPS = 10
    private var pointRevision = 0
    private var lastFrameTime: TimeInterval = 0
    private var settleUntil: TimeInterval = 0
    private var observers: [NSObjectProtocol] = []

    init(publish: @escaping (Event) -> Void) {
        self.publish = publish
        super.init()
        let center = NotificationCenter.default
        for notification in [Notification.Name.NSProcessInfoPowerStateDidChange, ProcessInfo.thermalStateDidChangeNotification] {
            observers.append(center.addObserver(forName: notification, object: nil, queue: nil) { [weak self] _ in
                self?.queue.async { [weak self] in self?.updateFrameRate() }
            })
        }
        observers.append(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification,
            object: captureSession, queue: nil) { [weak self] _ in
            self?.queue.async { [weak self] in self?.emit("paused") }
        })
        observers.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification,
            object: captureSession, queue: nil) { [weak self] _ in
            self?.queue.async { [weak self] in
                self?.reportError(code: "CAMERA_RUNTIME", message: "原生相机出现异常", hint: "请点重试相机。")
            }
        })
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    func start(_ stream: Int, fps: Int) {
        queue.async {
            guard self.stream != stream || !self.captureSession.isRunning else { return }
            self.stream = stream
            self.requestedFPS = fps
            self.wantsFrame = false
            self.pointRevision = 0
            self.lastFrameTime = 0
            self.settleUntil = ProcessInfo.processInfo.systemUptime + 0.35
            do {
                if self.device == nil {
                    try self.configure()
                }
                self.updateFrameRate()
                try self.applyMeterPoint(x: 0.5, y: 0.5, revision: 0)
                if !self.captureSession.isRunning {
                    self.captureSession.startRunning()
                }
                if self.captureSession.isRunning {
                    self.emit("ready")
                } else {
                    self.reportError(code: "NOT_RUNNING", message: "原生相机未能启动", hint: "请点重试相机。")
                }
            } catch {
                self.reportError(code: "START_FAILED", message: "无法启动后置相机", hint: error.localizedDescription)
            }
        }
    }

    func stop(_ stream: Int) {
        queue.async {
            guard self.stream == stream else { return }
            self.stream = nil
            self.wantsFrame = false
            if self.captureSession.isRunning {
                self.captureSession.stopRunning()
            }
        }
    }

    func nextFrame(_ stream: Int) {
        queue.async {
            if self.stream == stream { self.wantsFrame = true }
        }
    }

    func setPreviewRate(stream: Int, fps: Int) {
        queue.async {
            guard self.stream == stream, self.requestedFPS != fps else { return }
            self.requestedFPS = fps
            self.updateFrameRate()
        }
    }

    private func updateFrameRate() {
        guard stream != nil, let device else { return }
        let process = ProcessInfo.processInfo
        let powerLimited = process.isLowPowerModeEnabled || [.serious, .critical].contains(process.thermalState)
        deliveryFPS = powerLimited ? min(requestedFPS, 6) : requestedFPS

        // Limit the sensor's maximum rate while leaving long low-light exposures available.
        let target = Double(min(24, deliveryFPS * 2))
        let ranges = device.activeFormat.videoSupportedFrameRateRanges
        let supportedRates = ranges.map { min($0.maxFrameRate, max($0.minFrameRate, target)) }
        guard let rate = supportedRates.min(by: { abs($0 - target) < abs($1 - target) }) else { return }
        let range = ranges.first { $0.minFrameRate <= rate && rate <= $0.maxFrameRate }
        guard let range else { return }
        let duration = rate == range.minFrameRate ? range.maxFrameDuration
            : rate == range.maxFrameRate ? range.minFrameDuration
            : CMTime(seconds: 1 / rate, preferredTimescale: 60_000)
        guard !device.activeVideoMaxFrameDuration.isNumeric || duration <= device.activeVideoMaxFrameDuration else { return }
        guard duration != device.activeVideoMinFrameDuration else { return }
        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            device.activeVideoMinFrameDuration = duration
        } catch {
            // The software delivery cap still applies.
        }
    }

    func setMeterPoint(stream: Int, x: Double, y: Double, revision: Int) {
        queue.async {
            guard self.stream == stream, revision >= self.pointRevision else { return }
            do {
                try self.applyMeterPoint(x: x, y: y, revision: revision)
            } catch {
                self.reportError(code: "EXPOSURE_POINT", message: "相机无法设置测光区域", hint: "请点重试相机。")
            }
        }
    }

    private func emit(_ type: String, _ payload: Event = [:]) {
        guard let stream else { return }
        var event = payload
        event["session"] = stream
        event["type"] = type
        publish(event)
    }

    private func reportError(code: String, message: String, hint: String) {
        emit("error", ["code": code, "message": message, "hint": hint])
    }

    private func configure() throws {
        // The fixed wide camera avoids automatic switching between lenses.
        guard let wide = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw failure("此设备没有可用的后置主摄。")
        }
        let input = try AVCaptureDeviceInput(device: wide)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)

        captureSession.beginConfiguration()
        defer { captureSession.commitConfiguration() }
        guard captureSession.canAddInput(input) else {
            throw failure("无法连接后置相机。")
        }
        captureSession.addInput(input)
        guard captureSession.canAddOutput(output) else {
            captureSession.removeInput(input)
            throw failure("设备无法提供取景视频流。")
        }
        captureSession.addOutput(output)

        // This app keeps its camera view in portrait orientation.
        if captureSession.canSetSessionPreset(.vga640x480) {
            captureSession.sessionPreset = .vga640x480
        }
        if let connection = output.connection(with: .video) {
            #if os(iOS)
            if #available(iOS 17.0, *), connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90
            } else if connection.isVideoOrientationSupported {
                connection.videoOrientation = .portrait
            }
            #endif
        }
        device = wide
    }

    private func applyMeterPoint(x: Double, y: Double, revision: Int) throws {
        guard let device, device.isExposureModeSupported(.continuousAutoExposure) else {
            throw failure("设备不支持连续自动曝光。")
        }
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        if device.isExposurePointOfInterestSupported {
            // The bridge supplies portrait frame coordinates. AVFoundation expects landscape sensor coordinates.
            device.exposurePointOfInterest = CGPoint(x: y, y: 1 - x)
        }
        device.exposureMode = .continuousAutoExposure
        pointRevision = revision
        settleUntil = ProcessInfo.processInfo.systemUptime + 0.3
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard stream != nil, wantsFrame, let device,
              let buffer = CMSampleBufferGetImageBuffer(sample) else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastFrameTime >= 0.9 / Double(deliveryFPS) else { return }

        let shutter = device.exposureDuration.seconds
        let iso = Double(device.iso)
        let aperture = Double(device.lensAperture)
        let offset = Double(device.exposureTargetOffset)
        let valid = [shutter, iso, aperture].allSatisfy { $0.isFinite && $0 > 0 }
        let exposure: Any
        if valid, offset.isFinite {
            exposure = [
                "shutter": shutter, "iso": iso, "aperture": aperture,
                "offset": offset, "adjusting": device.isAdjustingExposure || now < settleUntil,
                "pointSupported": device.isExposurePointOfInterestSupported
            ] as [String: Any]
        } else {
            exposure = NSNull()
        }

        var preview = CIImage(cvPixelBuffer: buffer)
        let longest = max(preview.extent.width, preview.extent.height)
        if longest > 560 {
            let scale = 560 / longest
            preview = preview.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        guard let data = context.jpegRepresentation(of: preview, colorSpace: colorSpace, options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.65]) else { return }
        wantsFrame = false
        lastFrameTime = now
        emit("frame", ["jpegData": data, "exposure": exposure, "revision": pointRevision])
    }

    private func failure(_ hint: String) -> NSError {
        NSError(domain: "LightNo.Camera", code: 1, userInfo: [NSLocalizedDescriptionKey: hint])
    }
}
