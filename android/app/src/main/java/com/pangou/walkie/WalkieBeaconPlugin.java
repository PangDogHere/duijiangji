package com.pangou.walkie;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 局域网频道信标 —— 支撑「附近有可以连接的频道」这个功能。
 *
 * 为什么用 UDP 广播而不是 NAS/NSD(mDNS)：
 *  Android 的 NsdManager 在 12+ 上行为不一致（resolve 经常超时、部分机型压根不回调），
 *  而我们对讲机的主场景就是"同一现场/同一 WiFi"，一个自建的小广播包最可控：
 *  数据格式自己定、超时自己定、无依赖无系统坑。
 *
 * 协议：UDP 45871，纯文本 JSON，一行一个包
 *   { magic:"PANGOU-WALKIE", proto:1, inst:"A1B2C3D4",
 *     code:"K7M4XQ", name:"胖狗", host:"胖狗", members:3 }
 *
 * 行为：
 *   · announce=true  → 每 2s 广播自己的频道（只有中继台会开）
 *   · 任何情况下都在监听，收到别人的包就通过 "nearby" 事件上报给 Web 层
 *   · inst 是本机实例 id，用来过滤掉自己发出去的包
 *
 * 局限（必须知道）：要求两端在同一二层网络（同一路由器/同一 AP）。
 * 开了"AP 隔离"(客户端隔离) 的公共 WiFi 收不到广播，跨网络也不行。
 */
@CapacitorPlugin(name = "WalkieBeacon")
public class WalkieBeaconPlugin extends Plugin {

    private static final String TAG = "WalkieBeacon";
    private static final String MAGIC = "PANGOU-WALKIE";
    private static final int PROTO = 1;
    private static final int PORT = 45871;
    private static final long ANNOUNCE_INTERVAL_MS = 2000L;

    private DatagramSocket socket;
    private Thread listenThread;
    private Thread announceThread;
    private final AtomicBoolean running = new AtomicBoolean(false);

    private volatile byte[] payload;          // 本机要广播的内容（announce=false 时为 null）
    private volatile String myInstance = "";
    private WifiManager.MulticastLock mcastLock;

    /* ------------------------------------------------------------------ */
    /* 对外方法                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 开始监听（并在 announce=true 时开始广播自己）。
     * JS: WalkieBeacon.start({ instance, announce, code, name, host, members })
     */
    @PluginMethod
    public void start(PluginCall call) {
        String instance = call.getString("instance", "");
        Boolean announce = call.getBoolean("announce", Boolean.FALSE);

        if (instance == null || instance.length() == 0) {
            call.reject("缺少 instance（本机实例 id）");
            return;
        }

        if (running.get()) {
            // 已经在跑：只更新广播内容，避免重复开线程
            myInstance = instance;
            payload = announce != null && announce ? buildPayload(call) : null;
            JSObject r = new JSObject();
            r.put("running", true);
            r.put("port", PORT);
            r.put("reused", true);
            call.resolve(r);
            return;
        }

        myInstance = instance;
        payload = (announce != null && announce) ? buildPayload(call) : null;

        try {
            DatagramSocket s = new DatagramSocket(null);
            s.setReuseAddress(true);
            s.bind(new InetSocketAddress(PORT));
            s.setBroadcast(true);
            s.setSoTimeout(600);
            socket = s;
        } catch (Exception e) {
            Log.e(TAG, "绑定 UDP 端口失败: " + e.getMessage());
            call.reject("无法监听局域网端口 " + PORT + "：" + e.getMessage());
            return;
        }

        acquireMulticastLock();
        running.set(true);

        listenThread = new Thread(this::listenLoop, "walkie-beacon-listen");
        listenThread.setDaemon(true);
        listenThread.start();

        if (payload != null) {
            announceThread = new Thread(this::announceLoop, "walkie-beacon-announce");
            announceThread.setDaemon(true);
            announceThread.start();
        }

        JSObject r = new JSObject();
        r.put("running", true);
        r.put("port", PORT);
        r.put("announcing", payload != null);
        call.resolve(r);
    }

    /**
     * 更新自己的广播内容（成员数变化、进入/离开频道时会调）。
     * JS: WalkieBeacon.update({ announce, code, name, host, members })
     */
    @PluginMethod
    public void update(PluginCall call) {
        Boolean announce = call.getBoolean("announce", Boolean.FALSE);
        payload = (announce != null && announce) ? buildPayload(call) : null;

        // 从"只监听"变成"要广播"时，需要补起广播线程
        if (payload != null && running.get() && (announceThread == null || !announceThread.isAlive())) {
            announceThread = new Thread(this::announceLoop, "walkie-beacon-announce");
            announceThread.setDaemon(true);
            announceThread.start();
        }

        JSObject r = new JSObject();
        r.put("announcing", payload != null);
        call.resolve(r);
    }

    /** JS: WalkieBeacon.stop() */
    @PluginMethod
    public void stop(PluginCall call) {
        shutdown();
        JSObject r = new JSObject();
        r.put("running", false);
        call.resolve(r);
    }

    /** 诊断用：本机在局域网里的地址与广播地址 */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("port", PORT);
        r.put("running", running.get());
        r.put("announcing", payload != null);
        r.put("instance", myInstance);
        List<String> ips = new ArrayList<>();
        for (InetAddress a : broadcastAddresses()) ips.add(a.getHostAddress());
        r.put("broadcastTargets", new JSONArray(ips));
        r.put("localIps", new JSONArray(localIps()));
        call.resolve(r);
    }

    @Override
    protected void handleOnDestroy() {
        shutdown();
        super.handleOnDestroy();
    }

    /* ------------------------------------------------------------------ */
    /* 内部实现                                                            */
    /* ------------------------------------------------------------------ */

    private byte[] buildPayload(PluginCall call) {
        try {
            JSONObject o = new JSONObject();
            o.put("magic", MAGIC);
            o.put("proto", PROTO);
            o.put("inst", myInstance);
            o.put("code", trim(call.getString("code", ""), 8).toUpperCase());
            o.put("name", trim(call.getString("name", ""), 20));
            o.put("host", trim(call.getString("host", ""), 20));
            Integer members = call.getInt("members", Integer.valueOf(1));
            o.put("members", members == null ? 1 : members.intValue());
            return o.toString().getBytes(Charset.forName("UTF-8"));
        } catch (Exception e) {
            Log.e(TAG, "构造广播内容失败: " + e.getMessage());
            return null;
        }
    }

    private static String trim(String s, int n) {
        if (s == null) return "";
        s = s.trim();
        return s.length() > n ? s.substring(0, n) : s;
    }

    private void listenLoop() {
        byte[] buf = new byte[1024];
        while (running.get()) {
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                socket.receive(p);
                String text = new String(p.getData(), 0, p.getLength(), Charset.forName("UTF-8"));
                JSONObject o = new JSONObject(text);
                if (!MAGIC.equals(o.optString("magic"))) continue;
                if (myInstance != null && myInstance.length() > 0
                        && myInstance.equals(o.optString("inst"))) continue;   // 自己发的，丢掉

                String code = o.optString("code", "");
                if (code.length() == 0) continue;                              // 没有频道码的公告无意义

                JSObject out = JSObject.fromJSONObject(o);
                out.put("ip", p.getAddress().getHostAddress());
                out.put("seenAt", System.currentTimeMillis());
                notifyListeners("nearby", out, true);
            } catch (SocketTimeoutException te) {
                // 正常：用来周期性检查 running 标志
            } catch (Exception e) {
                if (running.get()) Log.w(TAG, "收包异常: " + e.getMessage());
                // 瞬时错误不致命（例如 socket 正在关闭），继续循环
            }
        }
    }

    private void announceLoop() {
        while (running.get()) {
            byte[] data = payload;
            if (data != null) {
                for (InetAddress addr : broadcastAddresses()) {
                    try {
                        socket.send(new DatagramPacket(data, data.length, addr, PORT));
                    } catch (Exception e) {
                        // 某个网卡发不出去很正常（比如 VPN/虚拟网卡），忽略
                    }
                }
            }
            try {
                Thread.sleep(ANNOUNCE_INTERVAL_MS);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /** 受限广播 + 每个网卡的子网定向广播（后者在部分路由器上才放行，两个都发最稳） */
    private List<InetAddress> broadcastAddresses() {
        List<InetAddress> list = new ArrayList<>();
        try {
            list.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) {
        }
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress b = ia.getBroadcast();
                    if (b != null) list.add(b);
                }
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    private List<String> localIps() {
        List<String> list = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (a != null && a.getAddress().length == 4) list.add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    private void acquireMulticastLock() {
        try {
            WifiManager wm = (WifiManager) getContext().getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                mcastLock = wm.createMulticastLock("walkie-beacon");
                mcastLock.setReferenceCounted(false);
                mcastLock.acquire();
            }
        } catch (Exception e) {
            Log.w(TAG, "MulticastLock 获取失败（不影响 UDP 广播，只是个别机型收包会不稳）: " + e.getMessage());
        }
    }

    private void shutdown() {
        running.set(false);
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
        }
        socket = null;
        if (listenThread != null) {
            try { listenThread.join(400); } catch (InterruptedException ignored) { }
            listenThread = null;
        }
        if (announceThread != null) {
            try { announceThread.join(400); } catch (InterruptedException ignored) { }
            announceThread = null;
        }
        try {
            if (mcastLock != null && mcastLock.isHeld()) mcastLock.release();
        } catch (Exception ignored) {
        }
        mcastLock = null;
        payload = null;
    }
}
