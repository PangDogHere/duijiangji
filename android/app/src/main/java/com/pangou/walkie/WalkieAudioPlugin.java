package com.pangou.walkie;

import android.app.Activity;
import android.content.Context;
import android.media.AudioManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 音频输出路由插件。
 *
 * 存在的理由：对讲机的回音几乎全部来自「声学耦合」——
 * 对方喇叭放出来的声音被本机麦克风拾取后又传回去。
 * 切到听筒（earpiece）能让漏出去的声音降低 20~30dB，
 * 是"不戴耳机也能明显压回音"的主要手段。
 *
 * 权限模型：WebView 里拿不到 AudioManager，必须走原生。
 */
@CapacitorPlugin(name = "WalkieAudio")
public class WalkieAudioPlugin extends Plugin {

    @PluginMethod
    public void setRoute(PluginCall call) {
        String mode = call.getString("mode", "speaker");
        boolean wantSpeaker = !"earpiece".equalsIgnoreCase(mode);

        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) {
            call.reject("设备没有 AudioManager");
            return;
        }
        try {
            // 通讯模式是让 Android 启用 AEC/降噪的前提
            if (am.getMode() != AudioManager.MODE_IN_COMMUNICATION) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            }
            am.setSpeakerphoneOn(wantSpeaker);
            // 告知守卫线程，别把路由又抢回外放
            MainActivity.useSpeaker = wantSpeaker;
        } catch (Exception e) {
            call.reject("切换音频路由失败：" + e.getMessage());
            return;
        }

        JSObject r = new JSObject();
        r.put("mode", wantSpeaker ? "speaker" : "earpiece");
        call.resolve(r);
    }

    @PluginMethod
    public void getRoute(PluginCall call) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        JSObject r = new JSObject();
        if (am != null) {
            try {
                r.put("mode", am.isSpeakerphoneOn() ? "speaker" : "earpiece");
                r.put("audioMode", am.getMode());
            } catch (Exception ignored) {
            }
        }
        call.resolve(r);
    }

    /**
     * 请求 / 释放音频焦点。
     *
     * 用 VOICE_COMMUNICATION 的音频属性去抢焦点，效果相当于 VoNR 里给语音单独开一条
     * 5QI=1 的专用承载：别的 App 的通知音、音乐不会插进来，系统也不会把通话音量压下去。
     * 这是"听感质量"里最容易被忽略、但用户最容易察觉的一环。
     */
    @PluginMethod
    public void setVoiceFocus(PluginCall call) {
        Boolean on = call.getBoolean("on", Boolean.TRUE);
        Activity act = getActivity();
        if (act instanceof MainActivity) {
            ((MainActivity) act).setVoiceFocus(on == null || on.booleanValue());
        }
        JSObject r = new JSObject();
        r.put("focus", on == null || on.booleanValue());
        call.resolve(r);
    }
}
