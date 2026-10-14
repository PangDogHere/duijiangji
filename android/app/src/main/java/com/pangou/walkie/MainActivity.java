package com.pangou.walkie;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

/**
 * 对讲机原生壳。
 *
 * 除了承载 WebView，这里做四件"对讲机"该做的事：
 *  1. 保持屏幕常亮（对讲时不想屏幕熄灭）
 *  2. 把音频切到 MODE_IN_COMMUNICATION —— WebView 里 WebRTC 的 AEC/降噪要靠它才生效
 *  3. 维持用户选择的输出路由（外放 / 听筒），周期性重申，防止被系统抢回去
 *  4. 持有音频焦点 —— 避免别的 App（微信通知、音乐）在通话中抢走音频通道、
 *     或系统把通话音量压低。这直接关系到"听感质量"，跟 VoNR 里 QoS 独占承载是一个意思。
 */
public class MainActivity extends BridgeActivity {

    /** 由 WalkieAudioPlugin 写入：true=外放，false=听筒。守卫线程按它执行。 */
    public static volatile boolean useSpeaker = true;

    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private AudioManager.OnAudioFocusChangeListener legacyFocusListener;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean watchRoute = false;
    private boolean focusHeld = false;

    private final Runnable routeKeeper = new Runnable() {
        @Override
        public void run() {
            applyAudioRoute();
            if (watchRoute) {
                handler.postDelayed(this, 1500L);
            }
        }
    };

    /** 把音频模式与输出路由拉回目标状态；个别机型权限受限，失败忽略即可 */
    void applyAudioRoute() {
        try {
            if (audioManager == null) return;
            if (audioManager.getMode() != AudioManager.MODE_IN_COMMUNICATION) {
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            }
            if (audioManager.isSpeakerphoneOn() != useSpeaker) {
                audioManager.setSpeakerphoneOn(useSpeaker);
            }
        } catch (Exception ignored) {
        }
    }

    /** 由 WalkieAudioPlugin 调用：进入/离开频道时请求 / 释放音频焦点 */
    public void setVoiceFocus(final boolean on) {
        handler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (audioManager == null) return;
                    if (on) requestFocusInner();
                    else abandonFocusInner();
                } catch (Exception ignored) {
                }
            }
        });
    }

    private void requestFocusInner() {
        if (focusHeld) return;
        final AudioManager.OnAudioFocusChangeListener listener = new AudioManager.OnAudioFocusChangeListener() {
            @Override
            public void onAudioFocusChange(int changeHint) {
                // 通话中不做特殊处理：失焦时依然保持拾音，由 WebRTC 自身抗抖动
            }
        };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setWillPauseWhenDucked(false)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener(listener, handler)
                    .build();
            focusHeld = audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } else {
            legacyFocusListener = listener;
            focusHeld = audioManager.requestAudioFocus(
                    listener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN)
                    == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        }
    }

    private void abandonFocusInner() {
        if (!focusHeld || audioManager == null) { focusHeld = false; return; }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
            } else if (legacyFocusListener != null) {
                audioManager.abandonAudioFocus(legacyFocusListener);
            }
        } catch (Exception ignored) {
        }
        focusHeld = false;
        legacyFocusListener = null;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注意顺序：registerPlugin 只是往 builder 里登记，必须在 super.onCreate() 之前
        registerPlugin(WalkieAudioPlugin.class);
        registerPlugin(WalkieBeaconPlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
    }

    @Override
    public void onResume() {
        super.onResume();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        watchRoute = true;
        handler.post(routeKeeper);
    }

    @Override
    public void onPause() {
        watchRoute = false;
        handler.removeCallbacks(routeKeeper);
        abandonFocusInner();
        try {
            if (audioManager != null) {
                audioManager.setSpeakerphoneOn(false);
                audioManager.setMode(AudioManager.MODE_NORMAL);
            }
        } catch (Exception ignored) {
        }
        super.onPause();
    }

    /** 供诊断面板显示（Web 层通过插件暴露，这里仅作参考实现） */
    public List<String> audioState() {
        List<String> out = new ArrayList<>();
        try {
            if (audioManager != null) {
                out.add("mode=" + audioManager.getMode());
                out.add("speaker=" + audioManager.isSpeakerphoneOn());
                out.add("focus=" + focusHeld);
            }
        } catch (Exception ignored) {
        }
        return out;
    }
}
