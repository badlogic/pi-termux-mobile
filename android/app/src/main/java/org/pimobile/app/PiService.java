package org.pimobile.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Foreground service owning the Node bridge process.
 * Layout under filesDir:
 *   usr/      termux prefix (bin, lib, etc.)
 *   home/     HOME ($HOME/.pi/agent for auth.json, sessions under .pi/sessions)
 *   work/     default agent working directory
 *   runtime/  server.mjs + node_modules
 *   tmp/      TMPDIR
 */
public final class PiService extends Service {

    private static final String CHANNEL = "pi-runtime";
    private Process nodeProcess;
    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundWithNotification();
        acquireWakeLock();
        new Thread(() -> {
            try {
                // drop stale port before anything else: a leftover file would
                // make the UI load a dead bridge address
                new File(new File(getFilesDir(), "home"), ".pi-mobile/port").delete();
                if (!RuntimeInstaller.isInstalled(this)) RuntimeInstaller.install(this);
                startNode();
            } catch (Exception e) {
                android.util.Log.e("PiService", "start failed", e);
                try {
                    File f = new File(getFilesDir(), "log/service-error.txt");
                    f.getParentFile().mkdirs();
                    java.io.FileWriter w = new java.io.FileWriter(f, true);
                    w.write(e + "\n");
                    w.close();
                } catch (IOException ignored) { }
                stopSelf();
            }
        }, "pi-installer").start();
        return START_STICKY;
    }

    private void startNode() throws IOException {
        File files = getFilesDir();
        File prefix = new File(files, "usr");
        File home = new File(files, "home");
        File runtime = new File(files, "runtime");

        Map<String, String> env = new HashMap<>();
        env.put("HOME", home.getAbsolutePath());
        env.put("PREFIX", prefix.getAbsolutePath());
        env.put("TMPDIR", new File(files, "tmp").getAbsolutePath());
        env.put("PATH", prefix.getAbsolutePath() + "/bin:/system/bin:/system/xbin");
        env.put("LD_LIBRARY_PATH", prefix.getAbsolutePath() + "/lib");
        env.put("TERM", "dumb");
        env.put("LANG", "C.UTF-8");
        env.put("PI_WORKDIR", new File(files, "work").getAbsolutePath());
        env.put("PI_SHELL", new File(prefix, "bin/bash").getAbsolutePath());
        // Termux-built openssl hardcodes /data/data/com.termux paths — point at ours.
        env.put("OPENSSL_CONF", new File(prefix, "etc/tls/openssl.cnf").getAbsolutePath());
        env.put("SSL_CERT_FILE", new File(prefix, "etc/tls/cert.pem").getAbsolutePath());

        // one bridge per service instance; clear stale bridge state so the
        // UI never reads a dead port
        if (nodeProcess != null) { nodeProcess.destroy(); nodeProcess = null; }
        File stateDir = new File(home, ".pi-mobile");
        new File(stateDir, "port").delete();

        String node = new File(prefix, "bin/node").getAbsolutePath();
        String server = new File(runtime, "server.mjs").getAbsolutePath();

        List<String> cmd = new ArrayList<>();
        cmd.add(node);
        cmd.add(server);
        try {
            nodeProcess = spawn(cmd, env, home);
        } catch (IOException directFailed) {
            // targetSdk >= 29 on Android 10+: exec of app-private files is
            // blocked -> run the ELF through the system dynamic linker.
            cmd.set(0, "/system/bin/linker64");
            cmd.add(1, node);
            nodeProcess = spawn(cmd, env, home);
        }
    }

    private Process spawn(List<String> cmd, Map<String, String> env, File cwd) throws IOException {
        File log = new File(getFilesDir(), "log/node.log");
        log.getParentFile().mkdirs();
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().putAll(env);
        pb.directory(cwd);
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
        return pb.start();
    }

    private void startForegroundWithNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL, "pi runtime", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE);
        Notification n;
        if (Build.VERSION.SDK_INT >= 26) {
            n = new Notification.Builder(this, CHANNEL)
                    .setContentTitle("pi mobile")
                    .setContentText("agent runtime running")
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentIntent(pi)
                    .build();
        } else {
            n = new Notification.Builder(this)
                    .setContentTitle("pi mobile")
                    .setContentText("agent runtime running")
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentIntent(pi)
                    .build();
        }
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, n,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(1, n);
        }
    }

    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pimobile:runtime");
        wakeLock.acquire();
    }

    @Override
    public void onDestroy() {
        if (nodeProcess != null) nodeProcess.destroy();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
