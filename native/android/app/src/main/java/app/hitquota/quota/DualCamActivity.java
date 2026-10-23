package app.hitquota.quota;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.media.MediaRecorder;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLExt;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executor;

// Front and back at the same moment, for the Play Store app.
//
// A web page can only run one camera at a time, so in the browser Quota takes the back
// camera and then the front one straight after. Phones that can run two cameras together
// (Android 11 and newer, on hardware that says so) do it here: a full-screen camera of its
// own with both live side by side, a picture of both at the same instant, or a clip of
// both recorded together, with sound, into one video.
//
// What comes back is the same picture the iPhone and the page make: 1080×1920, the back
// camera on the left and the front on the right, each the shape of a phone screen, a
// green line between, a blur of the two above and below. The front camera is shown
// mirrored, the way every phone shows you yourself, and saved the way the world sees it.
//
// Both cameras feed textures on one thread, which draws the picture with OpenGL: to the
// screen, and while recording into the video encoder as well. Everything to do with the
// cameras, the drawing and the video happens on that thread; the buttons are on the main one.
public class DualCamActivity extends Activity implements SurfaceHolder.Callback {
    static final int W = 1080, H = 1920, LINE = 6;
    static final int GREEN = 0xFF2FD36F;
    // The panes: two phone-shaped halves, centred, with the line between them.
    static final int PW = (W - LINE) / 2, PH = Math.round(PW * 16f / 9f), PY = (H - PH) / 2;

    // The back and front cameras this phone can run at once, or null if it can't.
    static String[] pair(Context c) {
        if (Build.VERSION.SDK_INT < 30) return null;
        try {
            CameraManager m = c.getSystemService(CameraManager.class);
            for (Set<String> set : m.getConcurrentCameraIds()) {
                String back = null, front = null;
                for (String id : set) {
                    Integer f = m.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
                    if (f == null) continue;
                    if (f == CameraCharacteristics.LENS_FACING_BACK && back == null) back = id;
                    else if (f == CameraCharacteristics.LENS_FACING_FRONT && front == null) front = id;
                }
                if (back != null && front != null) return new String[] { back, front };
            }
        } catch (Exception e) {
            // no camera service, or it would not say: not this phone
        }
        return null;
    }

    private boolean video;
    private double maxSeconds;
    // The flash, on both cameras at once: the light on the back, and for the front the
    // screen as bright as it goes: all of it white for a picture, a ring light around the
    // pictures for a clip.
    private volatile boolean flashOn, torchOn;
    private TextView flashButton;
    private View white;
    private Ring ring;
    private float brightnessWas = -2;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private HandlerThread thread;
    private Handler work;
    private boolean finished;

    // ---- on the work thread
    private CameraManager manager;
    private String[] ids;
    private final Cam back = new Cam(false), front = new Cam(true);
    private EGLDisplay dpy = EGL14.EGL_NO_DISPLAY;
    private EGLContext ctx = EGL14.EGL_NO_CONTEXT;
    private EGLConfig cfg;
    private EGLSurface idle = EGL14.EGL_NO_SURFACE, screen = EGL14.EGL_NO_SURFACE, enc = EGL14.EGL_NO_SURFACE;
    private int screenW, screenH;
    private int progOes, prog2d;
    private int photoFbo, photoTex;
    private boolean photoWanted;
    private volatile boolean ready;
    private boolean started;                       // this activity is in front: cameras wanted
    private int openTries;
    // Android 13 and newer can be told not to mirror the front camera; before that, it is
    // always mirrored in what arrives, so it is turned back round for what is saved.
    private final boolean frontArrivesMirrored = Build.VERSION.SDK_INT < 33;

    // recording
    private MediaCodec venc;
    private Surface vencSurface;
    private int vencW, vencH;
    private MediaMuxer muxer;
    private File outFile;
    private boolean recording, stopping;
    // Read by the sound's thread too.
    private volatile long offsetNs, lastVideoPts = -1;
    private volatile boolean gapPending;
    private volatile long recordedNs;
    private volatile boolean audioOn;
    private Thread audioThread;
    private final Object mux = new Object();
    private int videoTrack = -1, audioTrack = -1;
    private boolean muxStarted, expectAudio;
    private int videoSamples;
    private final List<Pending> pending = new ArrayList<>();

    // ---- on the main thread
    private SurfaceView view;
    private Shutter shutter;
    private TextView clock, note, closeButton;
    private boolean uiRecording;

    // One camera: its texture, where its frames arrive, and the camera itself.
    private static final class Cam {
        final boolean isFront;
        int tex, smallFbo, smallTex;
        SurfaceTexture st;
        Surface surface;
        CameraDevice device;
        CameraCaptureSession session;
        Size size = new Size(1280, 720);
        boolean have, fresh;
        final float[] m = new float[16];
        Cam(boolean isFront) { this.isFront = isFront; }
    }
    private static final class Pending {
        final boolean isVideo; final byte[] data; final MediaCodec.BufferInfo info;
        Pending(boolean v, byte[] d, MediaCodec.BufferInfo i) { isVideo = v; data = d; info = i; }
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        video = getIntent().getBooleanExtra("video", false);
        maxSeconds = getIntent().getDoubleExtra("maxSeconds", 0);
        flashOn = getIntent().getBooleanExtra("flash", false);
        torchOn = flashOn && video;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);   // nobody touches the glass mid-clip
        buildUi();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    new OnBackInvokedCallback() { @Override public void onBackInvoked() { closeTapped(); } });
        }
        thread = new HandlerThread("quota-dualcam");
        thread.start();
        work = new Handler(thread.getLooper());
        work.post(this::setUp);
        // Two cameras that never show a picture are not going to.
        ui.postDelayed(() -> { if (!ready && !finished) fail("Both cameras couldn't be started."); }, 8000);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() { closeTapped(); }

    // The camera is only the app's while it is in front: a call taking the screen, the home
    // button, the phone locking all take it away. A clip is not ended by that: it waits,
    // and carries on where it left off when the app is back, with the gap taken out.
    @Override
    protected void onStart() {
        super.onStart();
        work.post(() -> { started = true; openTries = 0; openCameras(); });
    }
    @Override
    protected void onStop() {
        super.onStop();
        work.post(() -> { started = false; closeCameras(); if (recording) gapPending = true; });
    }
    @Override
    protected void onDestroy() {
        super.onDestroy();
        ui.removeCallbacksAndMessages(null);
        work.post(() -> { closeCameras(); if (recording) abandonRecording(); tearDown(); thread.quitSafely(); });
    }

    // ---- the drawing
    private void setUp() {
        manager = getSystemService(CameraManager.class);
        ids = pair(this);
        if (ids == null) { fail("This phone can't run both cameras at once."); return; }
        dpy = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        int[] v = new int[2];
        EGL14.eglInitialize(dpy, v, 0, v, 1);
        int[] want = {
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT | EGL14.EGL_PBUFFER_BIT,
            EGLExt.EGL_RECORDABLE_ANDROID, 1, EGL14.EGL_NONE };
        EGLConfig[] cfgs = new EGLConfig[1];
        int[] n = new int[1];
        if (!EGL14.eglChooseConfig(dpy, want, 0, cfgs, 0, 1, n, 0) || n[0] == 0) { fail("Both cameras couldn't be started."); return; }
        cfg = cfgs[0];
        ctx = EGL14.eglCreateContext(dpy, cfg, EGL14.EGL_NO_CONTEXT, new int[] { EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE }, 0);
        idle = EGL14.eglCreatePbufferSurface(dpy, cfg, new int[] { EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE }, 0);
        EGL14.eglMakeCurrent(dpy, idle, idle, ctx);
        progOes = program(FRAG_OES);
        prog2d = program(FRAG_2D);
        for (Cam c : new Cam[] { back, front }) {
            c.tex = texture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES);
            c.size = streamSize(c.isFront ? ids[1] : ids[0]);
            c.st = new SurfaceTexture(c.tex);
            c.st.setDefaultBufferSize(c.size.getWidth(), c.size.getHeight());
            c.surface = new Surface(c.st);
            final Cam cam = c;
            c.st.setOnFrameAvailableListener(t -> frame(cam), work);
            int[] fb = fbo(SMALL_W, SMALL_H);
            c.smallFbo = fb[0]; c.smallTex = fb[1];
        }
        int[] fb = fbo(W, H);
        photoFbo = fb[0]; photoTex = fb[1];
        if (started) openCameras();
    }

    // The largest 16:9 picture up to 1280 wide: what two cameras at once can be relied on for.
    private Size streamSize(String id) {
        try {
            StreamConfigurationMap map = manager.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size best = null;
            if (map != null) for (Size s : map.getOutputSizes(SurfaceTexture.class)) {
                if (s.getWidth() > 1280 || Math.abs(s.getWidth() * 9 - s.getHeight() * 16) > s.getWidth() / 10) continue;
                if (best == null || s.getWidth() > best.getWidth()) best = s;
            }
            if (best != null) return best;
        } catch (Exception e) { /* fall through */ }
        return new Size(1280, 720);
    }

    private void frame(Cam c) {
        if (ctx == EGL14.EGL_NO_CONTEXT) return;
        makeCurrent(screen != EGL14.EGL_NO_SURFACE ? screen : idle);
        try { c.st.updateTexImage(); } catch (RuntimeException e) { return; }
        c.st.getTransformMatrix(c.m);
        c.have = true;
        // The back camera sets the pace; each of its frames is drawn with the latest front one.
        if (c.isFront) { c.fresh = true; if (back.have) return; }
        if (!back.have || !front.have) return;
        if (!ready) { ready = true; ui.post(() -> shutter.setEnabled(true)); }
        draw();
    }

    private void draw() {
        // The blur behind: each camera drawn tiny, then stretched back up over its half.
        for (Cam c : new Cam[] { back, front }) {
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, c.smallFbo);
            GLES20.glViewport(0, 0, SMALL_W, SMALL_H);
            drawOes(c, (W / 2f) / H, false, 1f);
        }
        if (screen != EGL14.EGL_NO_SURFACE) {
            makeCurrent(screen);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
            // The picture, as wide as the screen and centred, black around it.
            int h = Math.round(screenW * (float) H / W), y = (screenH - h) / 2;
            clearTo(0, 0, screenW, screenH, Color.BLACK);
            compose(0, y, screenW / (float) W, true);
            EGL14.eglSwapBuffers(dpy, screen);
        }
        if (recording && !stopping && enc != EGL14.EGL_NO_SURFACE) {
            long now = System.nanoTime();
            if (lastVideoPts < 0) offsetNs = now;
            else if (gapPending) {
                offsetNs = now - (lastVideoPts + 33_333_333L);   // straight on from the last frame
                gapPending = false;
            }
            long pts = now - offsetNs;
            if (pts > lastVideoPts) {
                makeCurrent(enc);
                GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
                compose(0, 0, vencW / (float) W, false);
                EGLExt.eglPresentationTimeANDROID(dpy, enc, pts);
                EGL14.eglSwapBuffers(dpy, enc);
                lastVideoPts = pts;
                recordedNs = pts;
                drainVideo(false);
                if (maxSeconds > 0 && pts >= (long) (maxSeconds * 1e9)) stopRecording();
            }
        }
        if (photoWanted) {
            photoWanted = false;
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, photoFbo);
            compose(0, 0, 1f, false);
            ByteBuffer px = ByteBuffer.allocateDirect(W * H * 4).order(ByteOrder.nativeOrder());
            GLES20.glReadPixels(0, 0, W, H, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, px);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
            new Thread(() -> savePhoto(px), "quota-dualcam-photo").start();
        }
        makeCurrent(screen != EGL14.EGL_NO_SURFACE ? screen : idle);
    }

    // The whole picture into the bound target, at x0,y0 (from the bottom), scaled by k.
    // forScreen: the front camera is shown the way a mirror would.
    private void compose(int x0, int y0, float k, boolean forScreen) {
        boolean flipFront = forScreen != frontArrivesMirrored;
        clearTo(x0, y0, Math.round(W * k), Math.round(H * k), Color.BLACK);
        // the blur, each over its own half
        viewport(x0, y0, k, 0, 0, W / 2, H);
        draw2d(back.smallTex, false, 0.62f);
        viewport(x0, y0, k, W / 2, 0, W - W / 2, H);
        draw2d(front.smallTex, flipFront, 0.62f);
        // the panes (GL counts from the bottom; they are centred, so it is the same place)
        float aspect = PW / (float) PH;
        viewport(x0, y0, k, 0, PY, PW, PH);
        drawOes(back, aspect, false, 1f);
        viewport(x0, y0, k, PW + LINE, PY, PW, PH);
        drawOes(front, aspect, flipFront, 1f);
        clearTo(x0 + Math.round(PW * k), y0 + Math.round(PY * k), Math.max(1, Math.round(LINE * k)), Math.round(PH * k), GREEN);
    }

    private void viewport(int x0, int y0, float k, int x, int y, int w, int h) {
        GLES20.glViewport(x0 + Math.round(x * k), y0 + Math.round(y * k), Math.round(w * k), Math.round(h * k));
    }
    private void clearTo(int x, int y, int w, int h, int color) {
        GLES20.glEnable(GLES20.GL_SCISSOR_TEST);
        GLES20.glScissor(x, y, w, h);
        GLES20.glClearColor(Color.red(color) / 255f, Color.green(color) / 255f, Color.blue(color) / 255f, 1f);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        GLES20.glDisable(GLES20.GL_SCISSOR_TEST);
    }

    // A camera filling the current viewport (of the given shape), cropped rather than squashed.
    private void drawOes(Cam c, float viewAspect, boolean mirror, float dim) {
        // What arrives is already turned upright for a phone held up, so it is portrait.
        float imgAspect = c.size.getHeight() / (float) c.size.getWidth();
        float cx = 1f, cy = 1f;
        if (imgAspect > viewAspect) cx = viewAspect / imgAspect; else cy = imgAspect / viewAspect;
        GLES20.glUseProgram(progOes);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, c.tex);
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(progOes, "uST"), 1, false, c.m, 0);
        GLES20.glUniform2f(GLES20.glGetUniformLocation(progOes, "uCrop"), cx, cy);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(progOes, "uMirror"), mirror ? 1f : 0f);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(progOes, "uDim"), dim);
        quad(progOes);
    }
    private void draw2d(int tex, boolean mirror, float dim) {
        GLES20.glUseProgram(prog2d);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, tex);
        GLES20.glUniform2f(GLES20.glGetUniformLocation(prog2d, "uCrop"), 1f, 1f);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(prog2d, "uMirror"), mirror ? 1f : 0f);
        GLES20.glUniform1f(GLES20.glGetUniformLocation(prog2d, "uDim"), dim);
        quad(prog2d);
    }
    private void quad(int prog) {
        int a = GLES20.glGetAttribLocation(prog, "aPos");
        GLES20.glEnableVertexAttribArray(a);
        GLES20.glVertexAttribPointer(a, 2, GLES20.GL_FLOAT, false, 0, QUAD);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(a);
    }

    private static final int SMALL_W = 24, SMALL_H = 85;   // a half of the picture, tiny: the blur
    private static final FloatBuffer QUAD = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder())
            .asFloatBuffer().put(new float[] { -1, -1, 1, -1, -1, 1, 1, 1 });
    static { QUAD.position(0); }
    private static final String VERT =
        "attribute vec2 aPos; varying vec2 vUV;\n" +
        "void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }\n";
    private static final String PICK =
        "uniform vec2 uCrop; uniform float uMirror; uniform float uDim; varying vec2 vUV;\n" +
        "vec2 pick() { vec2 p = vUV; if (uMirror > 0.5) p.x = 1.0 - p.x; return 0.5 + (p - 0.5) * uCrop; }\n";
    private static final String FRAG_OES =
        "#extension GL_OES_EGL_image_external : require\n" +
        "precision mediump float;\n" + PICK +
        "uniform samplerExternalOES sTex; uniform mat4 uST;\n" +
        "void main() { vec2 t = (uST * vec4(pick(), 0.0, 1.0)).xy; gl_FragColor = vec4(texture2D(sTex, t).rgb * uDim, 1.0); }\n";
    private static final String FRAG_2D =
        "precision mediump float;\n" + PICK +
        "uniform sampler2D sTex;\n" +
        "void main() { gl_FragColor = vec4(texture2D(sTex, pick()).rgb * uDim, 1.0); }\n";

    private static int program(String frag) {
        int p = GLES20.glCreateProgram();
        GLES20.glAttachShader(p, shader(GLES20.GL_VERTEX_SHADER, VERT));
        GLES20.glAttachShader(p, shader(GLES20.GL_FRAGMENT_SHADER, frag));
        GLES20.glLinkProgram(p);
        GLES20.glUseProgram(p);
        GLES20.glUniform1i(GLES20.glGetUniformLocation(p, "sTex"), 0);
        return p;
    }
    private static int shader(int type, String src) {
        int s = GLES20.glCreateShader(type);
        GLES20.glShaderSource(s, src);
        GLES20.glCompileShader(s);
        return s;
    }
    private static int texture(int target) {
        int[] t = new int[1];
        GLES20.glGenTextures(1, t, 0);
        GLES20.glBindTexture(target, t[0]);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        return t[0];
    }
    private static int[] fbo(int w, int h) {
        int tex = texture(GLES20.GL_TEXTURE_2D);
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, w, h, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null);
        int[] f = new int[1];
        GLES20.glGenFramebuffers(1, f, 0);
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, f[0]);
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, tex, 0);
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
        return new int[] { f[0], tex };
    }
    private void makeCurrent(EGLSurface s) { EGL14.eglMakeCurrent(dpy, s, s, ctx); }

    // ---- the cameras
    private void openCameras() {
        if (ids == null || ctx == EGL14.EGL_NO_CONTEXT || !started) return;
        open(back, ids[0]);
        open(front, ids[1]);
    }

    @SuppressLint("MissingPermission")
    private void open(Cam c, String id) {
        if (c.device != null) return;
        try {
            manager.openCamera(id, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice d) {
                    if (!started) { d.close(); return; }
                    c.device = d;
                    session(c);
                }
                @Override public void onDisconnected(CameraDevice d) {
                    d.close();
                    if (c.device == d) { c.device = null; c.session = null; }
                    if (recording) gapPending = true;
                }
                @Override public void onError(CameraDevice d, int error) {
                    d.close();
                    if (c.device == d) { c.device = null; c.session = null; }
                    // The page's own camera can take a moment to let go: try again shortly.
                    if (started && openTries++ < 10) { work.postDelayed(() -> open(c, id), 300); return; }
                    if (recording) stopRecording();
                    else if (!ready) fail("Both cameras couldn't be started.");
                }
            }, work);
        } catch (CameraAccessException | SecurityException | IllegalArgumentException e) {
            if (started && openTries++ < 10) work.postDelayed(() -> open(c, id), 300);
            else if (!ready) fail("Both cameras couldn't be started.");
        }
    }

    private void session(Cam c) {
        try {
            OutputConfiguration oc = new OutputConfiguration(c.surface);
            if (c.isFront && Build.VERSION.SDK_INT >= 33) oc.setMirrorMode(OutputConfiguration.MIRROR_MODE_NONE);
            Executor ex = r -> work.post(r);
            CameraDevice d = c.device;
            d.createCaptureSession(new SessionConfiguration(SessionConfiguration.SESSION_REGULAR, Collections.singletonList(oc), ex,
                new CameraCaptureSession.StateCallback() {
                    @Override public void onConfigured(CameraCaptureSession s) {
                        if (c.device != d) { s.close(); return; }
                        c.session = s;
                        if (!repeat(c) && !ready) fail("Both cameras couldn't be started.");
                    }
                    @Override public void onConfigureFailed(CameraCaptureSession s) {
                        if (!ready) fail("This phone can't run both cameras at once right now.");
                    }
                }));
        } catch (CameraAccessException | IllegalStateException | IllegalArgumentException e) {
            if (!ready) fail("Both cameras couldn't be started.");
        }
    }

    // What each camera is asked for over and over: pictures, with the back one's light on
    // while the flash wants it.
    private boolean repeat(Cam c) {
        if (c.device == null || c.session == null) return false;
        try {
            CaptureRequest.Builder b = c.device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            b.addTarget(c.surface);
            if (!c.isFront && torchOn) {
                b.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
                b.set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_TORCH);
            }
            c.session.setRepeatingRequest(b.build(), null, work);
            return true;
        } catch (CameraAccessException | IllegalStateException | IllegalArgumentException e) {
            return false;
        }
    }
    private void torch(boolean on) {
        work.post(() -> { if (torchOn != on) { torchOn = on; repeat(back); } });
    }

    private void closeCameras() {
        for (Cam c : new Cam[] { back, front }) {
            if (c.session != null) { try { c.session.close(); } catch (Exception e) { /* gone already */ } c.session = null; }
            if (c.device != null) { c.device.close(); c.device = null; }
        }
    }

    // ---- the shutter
    private void shutterTapped() {
        if (!video) {
            shutter.setEnabled(false);
            if (!flashOn) { blink(); work.post(() -> photoWanted = true); return; }
            // The front camera lit by the screen, the back by its light; the picture is taken
            // once both have had a moment to come up.
            white.setAlpha(1f);
            screenBright(true);
            torch(true);
            ui.postDelayed(() -> work.post(() -> photoWanted = true), 900);
            ui.postDelayed(() -> { white.setAlpha(0f); screenBright(false); torch(false); }, 1150);
            return;
        }
        if (uiRecording) { shutter.setEnabled(false); work.post(this::stopRecording); }
        else work.post(this::startRecording);
    }

    private void savePhoto(ByteBuffer px) {
        try {
            px.rewind();
            Bitmap gl = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
            gl.copyPixelsFromBuffer(px);
            Matrix flip = new Matrix();
            flip.preScale(1, -1);                       // GL reads from the bottom up
            Bitmap up = Bitmap.createBitmap(gl, 0, 0, W, H, flip, false);
            File f = new File(getCacheDir(), "dual-" + UUID.randomUUID() + ".jpg");
            try (FileOutputStream out = new FileOutputStream(f)) { up.compress(Bitmap.CompressFormat.JPEG, 92, out); }
            finishWith(f, "image/jpeg", 0);
        } catch (Exception e) {
            ui.post(() -> { shutter.setEnabled(true); say("That didn't come out. Try again."); });
        }
    }

    private void startRecording() {
        if (recording || !ready) return;
        try {
            outFile = new File(getCacheDir(), "dual-" + UUID.randomUUID() + ".mp4");
            muxer = new MediaMuxer(outFile.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            venc = null;
            // Full size where the phone's encoder takes it, a little smaller where it doesn't.
            for (int[] s : new int[][] { { W, H }, { 720, 1280 } }) {
                MediaCodec c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
                try {
                    MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, s[0], s[1]);
                    f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
                    f.setInteger(MediaFormat.KEY_BIT_RATE, s[0] == W ? 4_000_000 : 2_500_000);
                    f.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
                    f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
                    c.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                    venc = c; vencW = s[0]; vencH = s[1];
                    break;
                } catch (RuntimeException e) { c.release(); }
            }
            if (venc == null) throw new IllegalStateException("no encoder");
            vencSurface = venc.createInputSurface();
            venc.start();
            enc = EGL14.eglCreateWindowSurface(dpy, cfg, vencSurface, new int[] { EGL14.EGL_NONE }, 0);
            synchronized (mux) {
                videoTrack = -1; audioTrack = -1; muxStarted = false; videoSamples = 0; pending.clear();
                expectAudio = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            }
            lastVideoPts = -1; gapPending = false; recordedNs = 0; stopping = false;
            recording = true;
            if (expectAudio) startAudio();
            ui.post(() -> setRecordingLook(true));
        } catch (Exception e) {
            abandonRecording();
            ui.post(() -> say("Recording didn't start. Try again."));
        }
    }

    private void stopRecording() {
        if (!recording || stopping) return;
        stopping = true;
        ui.post(() -> { shutter.setEnabled(false); clock.setText("Saving…"); });
        double secs = Math.max(0, lastVideoPts) / 1e9;
        try { drainVideo(true); } catch (Exception e) { /* what was written stays */ }
        audioOn = false;
        if (audioThread != null) { try { audioThread.join(3000); } catch (InterruptedException e) { /* carry on */ } audioThread = null; }
        boolean ok;
        synchronized (mux) {
            if (!muxStarted && videoTrack >= 0) startMuxer();      // the sound never came: a silent clip
            ok = muxStarted && videoSamples > 0;
            try { if (muxStarted) muxer.stop(); } catch (Exception e) { ok = false; }
        }
        releaseEncoder();
        recording = false; stopping = false;
        if (ok && secs >= 0.5) { finishWith(outFile, "video/mp4", secs); return; }
        if (outFile != null) outFile.delete();
        ui.post(() -> { setRecordingLook(false); shutter.setEnabled(true); say("That was too short to keep."); });
    }

    private void abandonRecording() {
        audioOn = false;
        if (audioThread != null) { try { audioThread.join(1000); } catch (InterruptedException e) { /* carry on */ } audioThread = null; }
        releaseEncoder();
        recording = false; stopping = false;
        if (outFile != null) outFile.delete();
    }

    private void releaseEncoder() {
        if (enc != EGL14.EGL_NO_SURFACE) { EGL14.eglDestroySurface(dpy, enc); enc = EGL14.EGL_NO_SURFACE; }
        if (venc != null) { try { venc.stop(); } catch (Exception e) { /* already */ } venc.release(); venc = null; }
        if (vencSurface != null) { vencSurface.release(); vencSurface = null; }
        synchronized (mux) { if (muxer != null) { try { muxer.release(); } catch (Exception e) { /* already */ } muxer = null; } }
    }

    private void drainVideo(boolean end) {
        if (venc == null) return;
        if (end) venc.signalEndOfInputStream();
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        int waits = 0;
        while (true) {
            int i = venc.dequeueOutputBuffer(info, end ? 10_000 : 0);
            if (i == MediaCodec.INFO_TRY_AGAIN_LATER) { if (!end || ++waits > 200) break; }
            else if (i == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                synchronized (mux) { videoTrack = muxer.addTrack(venc.getOutputFormat()); maybeStartMuxer(); }
            } else if (i >= 0) {
                ByteBuffer b = venc.getOutputBuffer(i);
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                if (info.size > 0 && b != null) write(true, b, info);
                venc.releaseOutputBuffer(i, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
            }
        }
    }

    // The sound, on a thread of its own, on the same clock as the pictures.
    @SuppressLint("MissingPermission")
    private void startAudio() {
        final int rate = 44100;
        final AudioRecord rec;
        final MediaCodec aenc;
        try {
            int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            rec = new AudioRecord(MediaRecorder.AudioSource.CAMCORDER, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 8192) * 2);
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) { rec.release(); throw new IllegalStateException("no mic"); }
            MediaFormat f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, 1);
            f.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            f.setInteger(MediaFormat.KEY_BIT_RATE, 96_000);
            f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
            aenc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
            aenc.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            aenc.start();
            rec.startRecording();
        } catch (Exception e) {
            synchronized (mux) { expectAudio = false; maybeStartMuxer(); }
            return;
        }
        audioOn = true;
        audioThread = new Thread(() -> {
            byte[] pcm = new byte[4096];
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long lastPts = -1;
            boolean eos = false;
            int waits = 0;
            try {
                while (true) {
                    if (!eos) {
                        int n = rec.read(pcm, 0, pcm.length);
                        long now = System.nanoTime();
                        boolean keep = n > 0 && lastVideoPts >= 0 && !gapPending && audioOn;
                        long pts = (now - offsetNs - n / 2 * 1_000_000_000L / rate) / 1000;
                        if (keep && pts > lastPts) {
                            int i = aenc.dequeueInputBuffer(10_000);
                            if (i >= 0) {
                                ByteBuffer in = aenc.getInputBuffer(i);
                                in.clear();
                                int k = Math.min(n, in.remaining());
                                in.put(pcm, 0, k);
                                aenc.queueInputBuffer(i, 0, k, pts, 0);
                                lastPts = pts;
                            }
                        }
                        if (!audioOn) {
                            int i = aenc.dequeueInputBuffer(10_000);
                            if (i >= 0) { aenc.queueInputBuffer(i, 0, 0, Math.max(0, lastPts + 1), MediaCodec.BUFFER_FLAG_END_OF_STREAM); eos = true; }
                        }
                    }
                    int o = aenc.dequeueOutputBuffer(info, eos ? 10_000 : 0);
                    if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        synchronized (mux) { audioTrack = muxer.addTrack(aenc.getOutputFormat()); maybeStartMuxer(); }
                    } else if (o >= 0) {
                        ByteBuffer b = aenc.getOutputBuffer(o);
                        if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                        if (info.size > 0 && b != null) write(false, b, info);
                        aenc.releaseOutputBuffer(o, false);
                        if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
                    } else if (eos && o == MediaCodec.INFO_TRY_AGAIN_LATER && ++waits > 100) {
                        break;                      // a second with nothing more: done
                    }
                }
            } catch (Exception e) {
                // the sound stops here; the pictures carry on
            } finally {
                try { rec.stop(); } catch (Exception e) { /* already */ }
                rec.release();
                try { aenc.stop(); } catch (Exception e) { /* already */ }
                aenc.release();
            }
        }, "quota-dualcam-audio");
        audioThread.start();
    }

    // Holding mux.
    private void maybeStartMuxer() {
        if (!muxStarted && videoTrack >= 0 && (!expectAudio || audioTrack >= 0)) startMuxer();
    }
    // Holding mux.
    private void startMuxer() {
        muxer.setOrientationHint(0);
        muxer.start();
        muxStarted = true;
        for (Pending p : pending) writeNow(p.isVideo, ByteBuffer.wrap(p.data), p.info);
        pending.clear();
    }
    private void write(boolean isVideo, ByteBuffer b, MediaCodec.BufferInfo info) {
        synchronized (mux) {
            if (muxer == null) return;
            if (muxStarted) { writeNow(isVideo, b, info); return; }
            // Until both tracks are known, nothing can be written: kept, not dropped (the
            // first picture is the one every other one is built on).
            byte[] copy = new byte[info.size];
            b.position(info.offset); b.limit(info.offset + info.size); b.get(copy);
            MediaCodec.BufferInfo i = new MediaCodec.BufferInfo();
            i.set(0, info.size, info.presentationTimeUs, info.flags);
            pending.add(new Pending(isVideo, copy, i));
        }
    }
    // Holding mux.
    private void writeNow(boolean isVideo, ByteBuffer b, MediaCodec.BufferInfo info) {
        int track = isVideo ? videoTrack : audioTrack;
        if (track < 0) return;
        b.position(info.offset); b.limit(info.offset + info.size);
        muxer.writeSampleData(track, b, info);
        if (isVideo) videoSamples++;
    }

    private void flashTapped() {
        flashOn = !flashOn;
        paintFlash();
        torch(flashOn && video);
    }
    private void paintFlash() {
        flashButton.setText("⚡");
        flashButton.setTextColor(flashOn ? GREEN : Color.WHITE);
        flashButton.setAlpha(flashOn ? 1f : 0.7f);
        flashButton.setContentDescription(flashOn ? "Flash on" : "Flash off");
        ring.setVisibility(flashOn && video ? View.VISIBLE : View.GONE);
        screenBright(flashOn && video);
    }
    private void screenBright(boolean on) {
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        if (on) { if (brightnessWas == -2) brightnessWas = lp.screenBrightness; lp.screenBrightness = 1f; }
        else if (brightnessWas != -2) { lp.screenBrightness = brightnessWas; brightnessWas = -2; }
        getWindow().setAttributes(lp);
    }

    // ---- leaving
    private void closeTapped() {
        if (uiRecording) { shutter.setEnabled(false); work.post(this::stopRecording); return; }   // ✕ mid-clip keeps it
        if (finished) return;
        finished = true;
        screenBright(false);
        setResult(RESULT_CANCELED);
        finish();
    }
    private void finishWith(File f, String mime, double secs) {
        ui.post(() -> {
            if (finished) return;
            finished = true;
            Intent data = new Intent();
            data.putExtra("path", "file://" + f.getAbsolutePath());
            data.putExtra("mime", mime);
            data.putExtra("seconds", secs);
            setResult(RESULT_OK, data);
            finish();
        });
    }
    private void fail(String why) {
        ui.post(() -> {
            if (finished) return;
            finished = true;
            Intent data = new Intent();
            data.putExtra("error", why);
            setResult(RESULT_CANCELED, data);
            finish();
        });
    }
    private void tearDown() {
        for (Cam c : new Cam[] { back, front }) {
            if (c.surface != null) c.surface.release();
            if (c.st != null) c.st.release();
        }
        if (dpy != EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(dpy, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            if (screen != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(dpy, screen);
            if (idle != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(dpy, idle);
            if (ctx != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(dpy, ctx);
            EGL14.eglTerminate(dpy);
        }
        screen = idle = EGL14.EGL_NO_SURFACE; ctx = EGL14.EGL_NO_CONTEXT; dpy = EGL14.EGL_NO_DISPLAY;
    }

    // ---- the screen it draws on
    @Override public void surfaceCreated(SurfaceHolder h) { }
    @Override public void surfaceChanged(SurfaceHolder h, int format, int w, int hh) {
        final Surface s = h.getSurface();
        work.post(() -> {
            if (ctx == EGL14.EGL_NO_CONTEXT) return;
            if (screen != EGL14.EGL_NO_SURFACE) { makeCurrent(idle); EGL14.eglDestroySurface(dpy, screen); }
            screen = EGL14.eglCreateWindowSurface(dpy, cfg, s, new int[] { EGL14.EGL_NONE }, 0);
            screenW = w; screenH = hh;
        });
    }
    @Override public void surfaceDestroyed(SurfaceHolder h) {
        // Has to be let go of before this returns, or the screen is pulled out from under it.
        final Object done = new Object();
        final boolean[] flag = { false };
        work.post(() -> {
            if (screen != EGL14.EGL_NO_SURFACE) { makeCurrent(idle); EGL14.eglDestroySurface(dpy, screen); screen = EGL14.EGL_NO_SURFACE; }
            synchronized (done) { flag[0] = true; done.notifyAll(); }
        });
        synchronized (done) {
            long until = System.currentTimeMillis() + 1000;
            while (!flag[0] && System.currentTimeMillis() < until) {
                try { done.wait(100); } catch (InterruptedException e) { break; }
            }
        }
    }

    // ---- what it looks like: the page's camera, in Android views
    private int dp(float v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics())); }

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        view = new SurfaceView(this);
        view.getHolder().addCallback(this);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));

        // The front camera's flash: a ring light for a clip, the whole screen white for a moment
        // for a picture.
        ring = new Ring(this);
        root.addView(ring, new FrameLayout.LayoutParams(-1, -1));
        white = new View(this);
        white.setBackgroundColor(Color.WHITE);
        white.setAlpha(0f);
        root.addView(white, new FrameLayout.LayoutParams(-1, -1));

        FrameLayout controls = new FrameLayout(this);
        root.addView(controls, new FrameLayout.LayoutParams(-1, -1));

        flashButton = new TextView(this);
        flashButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        flashButton.setGravity(Gravity.CENTER);
        GradientDrawable fdot = new GradientDrawable();
        fdot.setShape(GradientDrawable.OVAL);
        fdot.setColor(0x73000000);
        flashButton.setBackground(fdot);
        flashButton.setOnClickListener(v -> flashTapped());
        FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(dp(42), dp(42), Gravity.TOP | Gravity.END);
        flp.setMargins(0, dp(10), dp(14), 0);
        controls.addView(flashButton, flp);
        paintFlash();

        closeButton = new TextView(this);
        closeButton.setText("✕");
        closeButton.setTextColor(Color.WHITE);
        closeButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        closeButton.setGravity(Gravity.CENTER);
        GradientDrawable dot = new GradientDrawable();
        dot.setShape(GradientDrawable.OVAL);
        dot.setColor(0x73000000);
        closeButton.setBackground(dot);
        closeButton.setContentDescription("Close");
        closeButton.setOnClickListener(v -> closeTapped());
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(42), dp(42), Gravity.TOP | Gravity.START);
        lp.setMargins(dp(14), dp(10), 0, 0);
        controls.addView(closeButton, lp);

        clock = new TextView(this);
        clock.setTextColor(Color.WHITE);
        clock.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        clock.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        lp = new FrameLayout.LayoutParams(-2, dp(42), Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        lp.topMargin = dp(10);
        clock.setGravity(Gravity.CENTER);
        clock.setPadding(dp(13), 0, dp(13), 0);
        GradientDrawable cpill = new GradientDrawable();
        cpill.setCornerRadius(dp(21));
        cpill.setColor(0x73000000);                  // readable on the ring light too
        clock.setBackground(cpill);
        controls.addView(clock, lp);

        note = new TextView(this);
        note.setTextColor(Color.WHITE);
        note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        note.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        note.setPadding(dp(14), dp(6), dp(14), dp(6));
        GradientDrawable pill = new GradientDrawable();
        pill.setCornerRadius(dp(14));
        pill.setColor(0x99000000);
        note.setBackground(pill);
        note.setVisibility(View.GONE);
        lp = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        lp.topMargin = dp(66);
        controls.addView(note, lp);

        shutter = new Shutter(this, video);
        shutter.setEnabled(false);
        shutter.setContentDescription(video ? "Record" : "Take picture");
        shutter.setOnClickListener(v -> shutterTapped());
        lp = new FrameLayout.LayoutParams(dp(80), dp(80), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        lp.bottomMargin = dp(24);
        controls.addView(shutter, lp);

        TextView label = new TextView(this);
        label.setText(video ? "FRONT + BACK VIDEO" : "FRONT + BACK");
        label.setTextColor(GREEN);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        label.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        lp = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        lp.bottomMargin = dp(24 + 80 + 16);
        controls.addView(label, lp);

        // Edge to edge: the buttons stay clear of the camera cut-out and the gesture bar.
        controls.setOnApplyWindowInsetsListener((v, ins) -> {
            Insets i = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            ring.top = i.top; ring.bottom = i.bottom; ring.invalidate();
            return ins;
        });
        setContentView(root);
        WindowInsetsController wic = getWindow().getInsetsController();
        if (wic != null) {
            wic.hide(WindowInsets.Type.statusBars());
            wic.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!uiRecording) return;
            long s = recordedNs / 1_000_000_000L;
            String t = String.format(Locale.US, "● %d:%02d", s / 60, s % 60);
            if (maxSeconds > 0) t += String.format(Locale.US, " / %d:%02d", (long) maxSeconds / 60, (long) maxSeconds % 60);
            clock.setText(t);
            ui.postDelayed(this, 250);
        }
    };
    private void setRecordingLook(boolean on) {
        uiRecording = on;
        shutter.setRecording(on);
        shutter.setContentDescription(on ? "Stop" : "Record");
        if (on) { ui.removeCallbacks(tick); ui.post(tick); } else clock.setText("");
    }
    private void blink() {
        View v = new View(this);
        v.setBackgroundColor(Color.BLACK);
        v.setAlpha(0.85f);
        ((FrameLayout) view.getParent()).addView(v, new FrameLayout.LayoutParams(-1, -1));
        v.animate().alpha(0f).setDuration(280).withEndAction(() -> ((FrameLayout) v.getParent()).removeView(v)).start();
    }
    private final Runnable hideNote = () -> note.animate().alpha(0f).setDuration(300).withEndAction(() -> note.setVisibility(View.GONE)).start();
    private void say(String text) {
        note.setText(text);
        note.animate().cancel();
        note.setAlpha(1f);
        note.setVisibility(View.VISIBLE);
        ui.removeCallbacks(hideNote);
        ui.postDelayed(hideNote, 2400);
    }

    // The ring light: white all round, the pictures in a rounded window in the middle.
    static final class Ring extends View {
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final android.graphics.Path path = new android.graphics.Path();
        private final RectF hole = new RectF();
        int top, bottom;
        Ring(Context c) { super(c); p.setColor(0xFFFFFAF3); setVisibility(GONE); }
        @Override protected void onDraw(Canvas c) {
            float w = getWidth(), h = getHeight(), d = getResources().getDisplayMetrics().density;
            path.reset();
            path.setFillType(android.graphics.Path.FillType.EVEN_ODD);
            path.addRect(0, 0, w, h, android.graphics.Path.Direction.CW);
            hole.set(w * 0.06f, top + 68 * d, w * 0.94f, Math.max(top + 68 * d, h - bottom - 190 * d));
            path.addRoundRect(hole, 28 * d, 28 * d, android.graphics.Path.Direction.CW);
            c.drawPath(path, p);
        }
    }

    // The page's shutter: a white ring around green (a clip) or white (a picture), the
    // middle turning into a rounded square while recording.
    static final class Shutter extends View {
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG), fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF r = new RectF();
        private boolean rec;
        Shutter(Context c, boolean video) {
            super(c);
            ring.setStyle(Paint.Style.STROKE);
            ring.setColor(Color.WHITE);
            fill.setColor(video ? GREEN : Color.WHITE);
        }
        void setRecording(boolean on) { rec = on; invalidate(); }
        @Override public void setEnabled(boolean on) { super.setEnabled(on); setAlpha(on ? 1f : 0.5f); }
        @Override protected void onDraw(Canvas c) {
            float w = getWidth(), h = getHeight(), d = getResources().getDisplayMetrics().density;
            ring.setStrokeWidth(4 * d);
            c.drawCircle(w / 2, h / 2, Math.min(w, h) / 2 - 2 * d, ring);
            float half = rec ? 15 * d : 32 * d, corner = rec ? 8 * d : 32 * d;
            r.set(w / 2 - half, h / 2 - half, w / 2 + half, h / 2 + half);
            c.drawRoundRect(r, corner, corner, fill);
        }
    }
}
