import UIKit
import AVFoundation
import CoreImage
import Capacitor

// Front and back at the same moment, for the App Store app.
//
// A web page can only run one camera at a time, so in the browser Quota takes the back
// camera and then the front one straight after. A native app can run both at once, through
// AVCaptureMultiCamSession (iPhone XS / XR and newer), which is how Snapchat does it. This
// is that: a full-screen camera of its own with both cameras live side by side, a picture
// of both taken at the same instant, or a clip of both recorded together into one video.
//
// The page decides when to use it: Quota's own camera asks isAvailable() when it opens in
// the app, and its front-and-back button hands over to capture() here when the answer is
// yes. Everything else about the camera stays in the page.
//
// What comes back is the same shape as the page's own front-and-back picture: 1080×1920,
// the back camera on the left and the front on the right, each the shape of a phone
// screen, a green line between, the space above and below a blur of the two. Proof is
// drawn the way the world looks, so the front camera is not mirrored in what is saved
// (it is in the preview, the way every phone camera shows you yourself).
@objc(DualCamPlugin)
public class DualCamPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DualCamPlugin"
    public let jsName = "DualCam"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capture", returnType: CAPPluginReturnPromise),
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": AVCaptureMultiCamSession.isMultiCamSupported])
    }

    // { mode: 'photo' | 'video', maxSeconds?: number }
    //   -> { path, mime, seconds }, or rejected with code CANCELLED / DENIED / UNAVAILABLE.
    @objc func capture(_ call: CAPPluginCall) {
        guard AVCaptureMultiCamSession.isMultiCamSupported else {
            return call.reject("This phone can't run both cameras at once.", "UNAVAILABLE")
        }
        let video = call.getString("mode") == "video"
        let maxSeconds = call.getDouble("maxSeconds") ?? 0
        let flash = call.getBool("flash") ?? false
        DualCamPlugin.permitted(video: video) { ok in
            guard ok else { return call.reject("Quota isn't allowed to use the camera.", "DENIED") }
            DispatchQueue.main.async {
                guard let presenter = self.bridge?.viewController else { return call.reject("No screen to show it on.", "UNAVAILABLE") }
                let vc = DualCamViewController(video: video, maxSeconds: maxSeconds, flash: flash) { outcome in
                    switch outcome {
                    case .done(let url, let mime, let seconds):
                        call.resolve(["path": url.absoluteString, "mime": mime, "seconds": seconds])
                    case .cancelled:
                        call.reject("Closed.", "CANCELLED")
                    case .failed(let why):
                        call.reject(why, "UNAVAILABLE")
                    }
                }
                vc.modalPresentationStyle = .fullScreen
                presenter.present(vc, animated: true)
            }
        }
    }

    // The camera, and for a clip the microphone. Asked for here if they never have been; a
    // clip with the microphone refused still records, without sound.
    static func permitted(video: Bool, done: @escaping (Bool) -> Void) {
        func ask(_ type: AVMediaType, _ next: @escaping (Bool) -> Void) {
            switch AVCaptureDevice.authorizationStatus(for: type) {
            case .authorized: next(true)
            case .notDetermined: AVCaptureDevice.requestAccess(for: type) { next($0) }
            default: next(false)
            }
        }
        ask(.video) { cam in
            guard cam else { return done(false) }
            if video { ask(.audio) { _ in done(true) } } else { done(true) }
        }
    }
}

enum DualCamOutcome {
    case done(URL, String, Double)
    case cancelled
    case failed(String)
}

final class DualCamViewController: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let video: Bool
    private let maxSeconds: Double
    // The flash, on both cameras at once: the light on the back, and for the front the
    // screen as bright as it goes: all of it white for a picture, a ring light around the
    // pictures for a clip.
    private var flashOn: Bool
    private var backDevice: AVCaptureDevice?
    private let flashButton = UIButton(type: .system)
    private let white = UIView()
    private let ring = UIView()
    private let ringShape = CAShapeLayer()
    private var brightnessWas: CGFloat?
    private var finish: ((DualCamOutcome) -> Void)?

    private let session = AVCaptureMultiCamSession()
    private let sessionQueue = DispatchQueue(label: "quota.dualcam.session")
    private let dataQueue = DispatchQueue(label: "quota.dualcam.data")
    private let backOut = AVCaptureVideoDataOutput()
    private let frontOut = AVCaptureVideoDataOutput()
    private let audioOut = AVCaptureAudioDataOutput()
    private let backPreview = AVCaptureVideoPreviewLayer()
    private let frontPreview = AVCaptureVideoPreviewLayer()
    private let ci = CIContext(options: [.cacheIntermediates: false])

    // Touched only on dataQueue.
    private var lastBack: CVPixelBuffer?
    private var lastFront: CVPixelBuffer?
    private var writer: AVAssetWriter?
    private var writerVideo: AVAssetWriterInput?
    private var writerAudio: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var recording = false
    private var started = false
    private var firstTime = CMTime.invalid
    private var lastTime = CMTime.invalid
    // Time the camera spent away (a call, the app put away) is taken out of the clip, so it
    // carries on where it left off rather than holding a still frame for the gap.
    private var offset = CMTime.zero
    private var gapPending = false
    private var stopping = false

    // UI
    private let shutter = UIButton(type: .custom)
    private let shutterInner = UIView()
    private let closeButton = UIButton(type: .system)
    private let clock = UILabel()
    private let note = UILabel()
    private var ticker: Timer?
    private var recordStart = Date()
    private var awayStarted: Date?
    private var awayTotal: TimeInterval = 0

    private static let green = UIColor(red: 47 / 255, green: 211 / 255, blue: 111 / 255, alpha: 1)
    static let W = 1080, H = 1920, line = 6

    init(video: Bool, maxSeconds: Double, flash: Bool, finish: @escaping (DualCamOutcome) -> Void) {
        self.video = video
        self.maxSeconds = maxSeconds
        self.flashOn = flash
        self.finish = finish
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        for p in [backPreview, frontPreview] {
            p.videoGravity = .resizeAspectFill
            p.masksToBounds = true
            view.layer.addSublayer(p)
        }
        buildControls()
        sessionQueue.async { [weak self] in self?.configure() }
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(interrupted), name: .AVCaptureSessionWasInterrupted, object: session)
        nc.addObserver(self, selector: #selector(resumed), name: .AVCaptureSessionInterruptionEnded, object: session)
        nc.addObserver(self, selector: #selector(runtimeError), name: .AVCaptureSessionRuntimeError, object: session)
        nc.addObserver(self, selector: #selector(away), name: UIApplication.willResignActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(back), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true      // nobody touches the glass mid-clip
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The same layout as the picture: two phone-shaped panes side by side, centred.
        let b = view.bounds, pw = (b.width - 3) / 2, ph = min(pw * 16 / 9, b.height * 0.72), y = (b.height - ph) / 2
        CATransaction.begin(); CATransaction.setDisableActions(true)
        backPreview.frame = CGRect(x: 0, y: y, width: pw, height: ph)
        frontPreview.frame = CGRect(x: pw + 3, y: y, width: pw, height: ph)
        CATransaction.commit()
        divider.frame = CGRect(x: pw, y: y, width: 3, height: ph)
        // The ring light: white all round, the pictures in a rounded window in the middle.
        let s = view.safeAreaInsets
        let hole = CGRect(x: b.width * 0.06, y: s.top + 68, width: b.width * 0.88, height: max(0, b.height - s.top - 68 - s.bottom - 190))
        let path = UIBezierPath(rect: b)
        path.append(UIBezierPath(roundedRect: hole, cornerRadius: 28))
        ring.frame = b
        ringShape.frame = b
        ringShape.path = path.cgPath
    }
    private let divider = UIView()

    deinit { NotificationCenter.default.removeObserver(self) }

    // ---- the session
    private func configure() {
        guard let backCam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let frontCam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
            return fail("This phone doesn't have both cameras.")
        }
        backDevice = backCam
        session.beginConfiguration()
        do {
            try add(camera: backCam, output: backOut, preview: backPreview, mirrored: false)
            try add(camera: frontCam, output: frontOut, preview: frontPreview, mirrored: true)
            if video, AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
               let mic = AVCaptureDevice.default(for: .audio) {
                let micIn = try AVCaptureDeviceInput(device: mic)
                if session.canAddInput(micIn) {
                    session.addInputWithNoConnections(micIn)
                    if session.canAddOutput(audioOut) {
                        session.addOutputWithNoConnections(audioOut)
                        audioOut.setSampleBufferDelegate(self, queue: dataQueue)
                        let ports = micIn.ports.filter { $0.mediaType == .audio }
                        let conn = AVCaptureConnection(inputPorts: ports, output: audioOut)
                        if session.canAddConnection(conn) { session.addConnection(conn) }
                    }
                }
            }
        } catch {
            session.commitConfiguration()
            return fail("Both cameras couldn't be started.")
        }
        session.commitConfiguration()
        // Two cameras at once is something the phone can only just manage: if what was asked
        // for is more than it can carry, the answer is to say so and fall back, not to run
        // a session the system will cut off a few seconds in.
        if session.hardwareCost > 1.0 || session.systemPressureCost > 1.0 {
            return fail("This phone can't run both cameras at once right now.")
        }
        session.startRunning()
        torch(flashOn && video)
        DispatchQueue.main.async { self.shutter.isEnabled = true }
    }

    private func add(camera: AVCaptureDevice, output: AVCaptureVideoDataOutput, preview: AVCaptureVideoPreviewLayer, mirrored: Bool) throws {
        // The smallest format at least 1280 wide that the phone can run alongside another camera.
        let formats = camera.formats.filter { $0.isMultiCamSupported }
        let wide = formats.filter { CMVideoFormatDescriptionGetDimensions($0.formatDescription).width >= 1280 }
        if let f = wide.min(by: { CMVideoFormatDescriptionGetDimensions($0.formatDescription).width < CMVideoFormatDescriptionGetDimensions($1.formatDescription).width }) ?? formats.first {
            try camera.lockForConfiguration()
            camera.activeFormat = f
            camera.unlockForConfiguration()
        }
        let input = try AVCaptureDeviceInput(device: camera)
        guard session.canAddInput(input) else { throw NSError(domain: "dualcam", code: 1) }
        session.addInputWithNoConnections(input)
        guard let port = input.ports(for: .video, sourceDeviceType: camera.deviceType, sourceDevicePosition: camera.position).first else {
            throw NSError(domain: "dualcam", code: 2)
        }
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        guard session.canAddOutput(output) else { throw NSError(domain: "dualcam", code: 3) }
        session.addOutputWithNoConnections(output)
        output.setSampleBufferDelegate(self, queue: dataQueue)
        let conn = AVCaptureConnection(inputPorts: [port], output: output)
        guard session.canAddConnection(conn) else { throw NSError(domain: "dualcam", code: 4) }
        session.addConnection(conn)
        if conn.isVideoOrientationSupported { conn.videoOrientation = .portrait }
        if conn.isVideoMirroringSupported { conn.automaticallyAdjustsVideoMirroring = false; conn.isVideoMirrored = false }

        preview.setSessionWithNoConnection(session)
        let pconn = AVCaptureConnection(inputPort: port, videoPreviewLayer: preview)
        guard session.canAddConnection(pconn) else { throw NSError(domain: "dualcam", code: 5) }
        session.addConnection(pconn)
        if pconn.isVideoOrientationSupported { pconn.videoOrientation = .portrait }
        if pconn.isVideoMirroringSupported { pconn.automaticallyAdjustsVideoMirroring = false; pconn.isVideoMirrored = mirrored }
    }

    // ---- frames
    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output === audioOut { return appendAudio(sample) }
        guard let px = CMSampleBufferGetImageBuffer(sample) else { return }
        if output === frontOut { lastFront = px; return }
        lastBack = px
        // The back camera's frames set the clip's pace; each is drawn with the latest front one.
        guard recording, let front = lastFront, let w = writer, let input = writerVideo, let ad = adaptor else { return }
        var t = CMSampleBufferGetPresentationTimeStamp(sample)
        if gapPending, lastTime.isValid {
            // Back from a call or the app being away: take the gap out, less one frame.
            let gap = CMTimeSubtract(CMTimeSubtract(t, offset), lastTime)
            let frame = CMTime(value: 1, timescale: 30)
            if gap > frame { offset = CMTimeAdd(offset, CMTimeSubtract(gap, frame)) }
            gapPending = false
        }
        t = CMTimeSubtract(t, offset)
        if !started {
            guard w.status == .unknown || w.status == .writing else { return }
            if w.status == .unknown { w.startWriting(); w.startSession(atSourceTime: t) }
            firstTime = t
            started = true
        }
        guard w.status == .writing, input.isReadyForMoreMediaData, let pool = ad.pixelBufferPool else { return }
        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
        guard let dst = out else { return }
        ci.render(compose(back: CIImage(cvPixelBuffer: px), front: CIImage(cvPixelBuffer: front)), to: dst)
        if ad.append(dst, withPresentationTime: t) { lastTime = t }
    }

    private func appendAudio(_ sample: CMSampleBuffer) {
        guard recording, started, let input = writerAudio, input.isReadyForMoreMediaData, !gapPending else { return }
        let t = CMSampleBufferGetPresentationTimeStamp(sample)
        let shifted = CMTimeSubtract(t, offset)
        guard firstTime.isValid, shifted >= firstTime else { return }
        if offset == .zero { input.append(sample); return }
        var timing = CMSampleTimingInfo(duration: CMSampleBufferGetDuration(sample), presentationTimeStamp: shifted, decodeTimeStamp: .invalid)
        var copy: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sample, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &copy)
        if let c = copy { input.append(c) }
    }

    // The picture: 1080×1920, back on the left, front on the right, a green line between,
    // and a blur of the two filling the space above and below.
    private func compose(back: CIImage, front: CIImage) -> CIImage {
        let W = CGFloat(Self.W), H = CGFloat(Self.H), line = CGFloat(Self.line)
        let pw = (W - line) / 2, ph = (pw * 16 / 9).rounded(), y = ((H - ph) / 2).rounded()
        func cover(_ img: CIImage, _ rect: CGRect) -> CIImage {
            let e = img.extent, k = max(rect.width / e.width, rect.height / e.height)
            let scaled = img.transformed(by: CGAffineTransform(scaleX: k, y: k))
            let s = scaled.extent
            let moved = scaled.transformed(by: CGAffineTransform(translationX: rect.midX - s.midX, y: rect.midY - s.midY))
            return moved.cropped(to: rect)
        }
        func blurred(_ img: CIImage, _ rect: CGRect) -> CIImage {
            // Small, blurred, then drawn back up: cheap enough for every frame of a clip.
            let small = cover(img, CGRect(x: 0, y: 0, width: rect.width / 12, height: rect.height / 12))
            let soft = small.clampedToExtent().applyingGaussianBlur(sigma: 3).cropped(to: small.extent)
            return cover(soft, rect).applyingFilter("CIColorControls", parameters: [kCIInputBrightnessKey: -0.18])
        }
        let leftHalf = CGRect(x: 0, y: 0, width: W / 2, height: H), rightHalf = CGRect(x: W / 2, y: 0, width: W / 2, height: H)
        var out = CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: W, height: H))
        out = blurred(back, leftHalf).composited(over: out)
        out = blurred(front, rightHalf).composited(over: out)
        // Core Image counts y from the bottom; the panes are centred, so that is the same place.
        out = cover(back, CGRect(x: 0, y: y, width: pw, height: ph)).composited(over: out)
        out = cover(front, CGRect(x: pw + line, y: y, width: pw, height: ph)).composited(over: out)
        let g = CIImage(color: CIColor(red: 47 / 255, green: 211 / 255, blue: 111 / 255)).cropped(to: CGRect(x: pw, y: y, width: line, height: ph))
        return g.composited(over: out)
    }

    // ---- the shutter
    @objc private func shutterTapped() {
        if !video { return takePicture() }
        recording ? stopRecording() : startRecording()
    }

    private func takePicture() {
        shutter.isEnabled = false
        guard flashOn else { flashBlink(); return grabPicture() }
        // The front camera lit by the screen, the back by its light; the picture is taken
        // once both have had a moment to come up.
        white.alpha = 1
        brightnessWas = UIScreen.main.brightness
        UIScreen.main.brightness = 1
        torch(true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            self.grabPicture {
                DispatchQueue.main.async {
                    self.white.alpha = 0
                    if let b = self.brightnessWas { UIScreen.main.brightness = b; self.brightnessWas = nil }
                    self.torch(false)
                }
            }
        }
    }

    private func grabPicture(_ after: (() -> Void)? = nil) {
        dataQueue.async {
            defer { after?() }
            guard let b = self.lastBack, let f = self.lastFront else {
                DispatchQueue.main.async { self.shutter.isEnabled = true; self.say("Not ready yet. Try again.") }
                return
            }
            let img = self.compose(back: CIImage(cvPixelBuffer: b), front: CIImage(cvPixelBuffer: f))
            guard let cg = self.ci.createCGImage(img, from: img.extent),
                  let data = UIImage(cgImage: cg).jpegData(compressionQuality: 0.92) else {
                return DispatchQueue.main.async { self.shutter.isEnabled = true; self.say("That didn't come out. Try again.") }
            }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("dual-\(UUID().uuidString).jpg")
            do { try data.write(to: url) } catch {
                return DispatchQueue.main.async { self.shutter.isEnabled = true; self.say("That didn't save. Try again.") }
            }
            self.end(.done(url, "image/jpeg", 0))
        }
    }

    private func startRecording() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("dual-\(UUID().uuidString).mp4")
        guard let w = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return say("Recording didn't start. Try again.") }
        let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Self.W, AVVideoHeightKey: Self.H,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 4_000_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel] as [String: Any],
        ])
        vIn.expectsMediaDataInRealTime = true
        let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Self.W, kCVPixelBufferHeightKey as String: Self.H,
        ])
        guard w.canAdd(vIn) else { return say("Recording didn't start. Try again.") }
        w.add(vIn)
        var aIn: AVAssetWriterInput?
        if session.outputs.contains(audioOut) {
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVNumberOfChannelsKey: 1, AVSampleRateKey: 44100, AVEncoderBitRateKey: 96000,
            ])
            a.expectsMediaDataInRealTime = true
            if w.canAdd(a) { w.add(a); aIn = a }
        }
        dataQueue.async {
            self.writer = w; self.writerVideo = vIn; self.writerAudio = aIn; self.adaptor = ad
            self.started = false; self.firstTime = .invalid; self.lastTime = .invalid; self.offset = .zero; self.gapPending = false
            self.recording = true
        }
        recordStart = Date(); awayTotal = 0; awayStarted = nil
        setRecordingLook(true)
        ticker = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
        tick()
    }

    private func elapsed() -> TimeInterval {
        Date().timeIntervalSince(recordStart) - awayTotal - (awayStarted.map { Date().timeIntervalSince($0) } ?? 0)
    }

    private func tick() {
        let s = max(0, elapsed())
        clock.text = String(format: "● %d:%02d", Int(s) / 60, Int(s) % 60) + (maxSeconds > 0 ? String(format: " / %d:%02d", Int(maxSeconds) / 60, Int(maxSeconds) % 60) : "")
        if maxSeconds > 0 && s >= maxSeconds { stopRecording() }
    }

    private func stopRecording() {
        guard !stopping else { return }
        stopping = true
        ticker?.invalidate(); ticker = nil
        shutter.isEnabled = false
        clock.text = "Saving…"
        let secs = elapsed()
        dataQueue.async {
            self.recording = false
            guard let w = self.writer, self.started, w.status == .writing else {
                return DispatchQueue.main.async { self.stopping = false; self.setRecordingLook(false); self.shutter.isEnabled = true; self.say("That was too short to keep.") }
            }
            self.writerVideo?.markAsFinished(); self.writerAudio?.markAsFinished()
            w.finishWriting {
                if w.status == .completed { self.end(.done(w.outputURL, "video/mp4", secs)) }
                else { DispatchQueue.main.async { self.stopping = false; self.setRecordingLook(false); self.shutter.isEnabled = true; self.say("That clip didn't save. Try again.") } }
            }
        }
    }

    // ---- the phone getting in the way
    // A call, Siri, the app put away: the camera stops for a while. A clip is not ended by
    // it — the gap is taken out and it carries on when the camera is back.
    @objc private func interrupted() { markAway() }
    @objc private func resumed() { markBack() }
    @objc private func away() { markAway() }
    @objc private func back() {
        markBack()
        sessionQueue.async { if !self.session.isRunning { self.session.startRunning() } }
        torch(flashOn && video)                         // the light goes out while the app is away
    }

    private func torch(_ on: Bool) {
        sessionQueue.async {
            guard let d = self.backDevice, d.hasTorch, d.isTorchModeSupported(on ? .on : .off) else { return }
            do { try d.lockForConfiguration(); d.torchMode = on ? .on : .off; d.unlockForConfiguration() } catch {}
        }
    }

    private func bright(_ on: Bool) {
        if on {
            if brightnessWas == nil { brightnessWas = UIScreen.main.brightness }
            UIScreen.main.brightness = 1
        } else if let b = brightnessWas {
            UIScreen.main.brightness = b
            brightnessWas = nil
        }
    }

    @objc private func flashTapped() {
        flashOn.toggle()
        paintFlash()
        torch(flashOn && video)
        if flashOn && backDevice?.hasTorch == false { say("This phone's back camera has no light.") }
    }
    private func paintFlash() {
        flashButton.setImage(UIImage(systemName: flashOn ? "bolt.fill" : "bolt.slash"), for: .normal)
        flashButton.tintColor = flashOn ? Self.green : .white
        flashButton.accessibilityLabel = flashOn ? "Flash on" : "Flash off"
        ring.isHidden = !(flashOn && video)
        bright(flashOn && video)
    }
    private func markAway() {
        DispatchQueue.main.async { if self.awayStarted == nil { self.awayStarted = Date() } }
        dataQueue.async { if self.recording { self.gapPending = true } }
    }
    private func markBack() {
        DispatchQueue.main.async {
            if let a = self.awayStarted { self.awayTotal += Date().timeIntervalSince(a); self.awayStarted = nil }
        }
    }
    @objc private func runtimeError(_ n: Notification) {
        // Keep what was filmed; anything else, say so and let the page fall back.
        if recording { DispatchQueue.main.async { self.stopRecording() } }
        else { sessionQueue.async { self.session.startRunning() } }
    }

    // ---- leaving
    @objc private func closeTapped() {
        if recording { return stopRecording() }       // ✕ mid-clip keeps it, as in the page
        end(.cancelled)
    }
    private func fail(_ why: String) { end(.failed(why)) }
    private func end(_ outcome: DualCamOutcome) {
        torch(false)
        if let b = brightnessWas { UIScreen.main.brightness = b; brightnessWas = nil }
        sessionQueue.async { if self.session.isRunning { self.session.stopRunning() } }
        DispatchQueue.main.async {
            guard let done = self.finish else { return }
            self.finish = nil
            UIApplication.shared.isIdleTimerDisabled = false
            self.ticker?.invalidate()
            let leave = {
                if self.presentingViewController != nil { self.dismiss(animated: true) { done(outcome) } } else { done(outcome) }
            }
            // Failing to start can happen while it is still sliding up; it goes once it has arrived.
            if self.isBeingPresented, let tc = self.transitionCoordinator {
                tc.animate(alongsideTransition: nil) { _ in leave() }
            } else { leave() }
        }
    }

    // ---- what it looks like: the page's camera, in UIKit
    private func buildControls() {
        divider.backgroundColor = Self.green
        view.addSubview(divider)

        ringShape.fillRule = .evenOdd
        ringShape.fillColor = UIColor(red: 1, green: 0.98, blue: 0.953, alpha: 1).cgColor
        ring.layer.addSublayer(ringShape)
        ring.isUserInteractionEnabled = false
        view.addSubview(ring)
        white.backgroundColor = .white
        white.alpha = 0
        white.isUserInteractionEnabled = false
        white.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(white)

        flashButton.addTarget(self, action: #selector(flashTapped), for: .touchUpInside)
        flashButton.backgroundColor = UIColor(white: 0, alpha: 0.45)
        flashButton.layer.cornerRadius = 21
        flashButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(flashButton)
        paintFlash()

        closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
        closeButton.tintColor = .white
        closeButton.backgroundColor = UIColor(white: 0, alpha: 0.45)
        closeButton.layer.cornerRadius = 21
        closeButton.accessibilityLabel = "Close"
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(closeButton)

        clock.textColor = .white
        clock.font = UIFont.monospacedDigitSystemFont(ofSize: 16, weight: .semibold)
        clock.textAlignment = .center
        clock.backgroundColor = UIColor(white: 0, alpha: 0.45)   // readable on the ring light too
        clock.layer.cornerRadius = 15
        clock.layer.masksToBounds = true
        clock.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(clock)

        note.textColor = .white
        note.font = UIFont.systemFont(ofSize: 13, weight: .bold)
        note.textAlignment = .center
        note.backgroundColor = UIColor(white: 0, alpha: 0.6)
        note.layer.cornerRadius = 14; note.layer.masksToBounds = true
        note.alpha = 0
        note.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(note)

        shutter.layer.cornerRadius = 40
        shutter.layer.borderWidth = 4
        shutter.layer.borderColor = UIColor.white.cgColor
        shutter.accessibilityLabel = video ? "Record" : "Take picture"
        shutter.isEnabled = false
        shutter.addTarget(self, action: #selector(shutterTapped), for: .touchUpInside)
        shutter.translatesAutoresizingMaskIntoConstraints = false
        shutterInner.backgroundColor = video ? Self.green : .white
        shutterInner.layer.cornerRadius = 32
        shutterInner.isUserInteractionEnabled = false
        shutterInner.translatesAutoresizingMaskIntoConstraints = false
        shutter.addSubview(shutterInner)
        view.addSubview(shutter)

        let label = UILabel()
        label.text = video ? "FRONT + BACK VIDEO" : "FRONT + BACK"
        label.textColor = Self.green
        label.font = UIFont.systemFont(ofSize: 13, weight: .bold)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)

        let g = view.safeAreaLayoutGuide
        innerW = shutterInner.widthAnchor.constraint(equalToConstant: 64)
        innerH = shutterInner.heightAnchor.constraint(equalToConstant: 64)
        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 14),
            closeButton.topAnchor.constraint(equalTo: g.topAnchor, constant: 10),
            closeButton.widthAnchor.constraint(equalToConstant: 42), closeButton.heightAnchor.constraint(equalToConstant: 42),
            flashButton.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -14),
            flashButton.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
            flashButton.widthAnchor.constraint(equalToConstant: 42), flashButton.heightAnchor.constraint(equalToConstant: 42),
            white.leadingAnchor.constraint(equalTo: view.leadingAnchor), white.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            white.topAnchor.constraint(equalTo: view.topAnchor), white.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            clock.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            clock.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
            note.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            note.topAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 14),
            note.heightAnchor.constraint(equalToConstant: 28),
            shutter.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            shutter.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -24),
            shutter.widthAnchor.constraint(equalToConstant: 80), shutter.heightAnchor.constraint(equalToConstant: 80),
            shutterInner.centerXAnchor.constraint(equalTo: shutter.centerXAnchor),
            shutterInner.centerYAnchor.constraint(equalTo: shutter.centerYAnchor),
            innerW!, innerH!,
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.bottomAnchor.constraint(equalTo: shutter.topAnchor, constant: -16),
        ])
    }
    private var innerW: NSLayoutConstraint?
    private var innerH: NSLayoutConstraint?

    private func setRecordingLook(_ on: Bool) {
        innerW?.constant = on ? 30 : 64
        innerH?.constant = on ? 30 : 64
        UIView.animate(withDuration: 0.22) {
            self.shutterInner.layer.cornerRadius = on ? 8 : 32
            self.view.layoutIfNeeded()
        }
        shutter.accessibilityLabel = on ? "Stop" : "Record"
        if !on { clock.text = "" }
    }
    private func flashBlink() {
        let v = UIView(frame: view.bounds)
        v.backgroundColor = .black; v.alpha = 0.85
        view.addSubview(v)
        UIView.animate(withDuration: 0.28, animations: { v.alpha = 0 }) { _ in v.removeFromSuperview() }
    }
    private func say(_ text: String) {
        note.text = "   \(text)   "
        UIView.animate(withDuration: 0.2) { self.note.alpha = 1 }
        UIView.animate(withDuration: 0.3, delay: 2.4, options: []) { self.note.alpha = 0 }
    }
}
