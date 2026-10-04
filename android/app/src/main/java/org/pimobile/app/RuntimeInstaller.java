package org.pimobile.app;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Extracts the bundled runtime (Termux binaries + pi runtime) from assets
 * into the app's private files directory using the system toybox tar.
 */
final class RuntimeInstaller {

    static final String STAMP_NAME = ".runtime-version";
    static final int RUNTIME_VERSION = 38;

    private RuntimeInstaller() {}

    static boolean isInstalled(Context ctx) {
        File stamp = new File(ctx.getFilesDir(), STAMP_NAME);
        if (!stamp.isFile()) return false;
        try {
            byte[] b = new byte[(int) stamp.length()];
            try (InputStream in = new java.io.FileInputStream(stamp)) {
                int off = 0;
                while (off < b.length) {
                    int n = in.read(b, off, b.length - off);
                    if (n < 0) break;
                    off += n;
                }
            }
            return Integer.parseInt(new String(b).trim()) == RUNTIME_VERSION;
        } catch (Exception e) {
            return false;
        }
    }

    static void install(Context ctx) throws IOException, InterruptedException {
        File files = ctx.getFilesDir();
        AssetManager am = ctx.getAssets();

        File tmp = new File(ctx.getCacheDir(), "extract");
        tmp.mkdirs();

        extractTarAsset(am, tmp, files, "rootfs.bin");
        extractTarAsset(am, tmp, files, "runtime.bin");

        new File(files, "tmp").mkdirs();
        new File(files, "home").mkdirs();
        new File(files, "work").mkdirs();

        try (OutputStream out = new FileOutputStream(new File(files, STAMP_NAME))) {
            out.write(String.valueOf(RUNTIME_VERSION).getBytes("UTF-8"));
        }
        deleteRecursive(tmp);
    }

    private static void extractTarAsset(AssetManager am, File tmp, File dest, String name)
            throws IOException, InterruptedException {
        File tar = new File(tmp, name);
        try (InputStream in = am.open(name); OutputStream out = new FileOutputStream(tar)) {
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
        }
        Process p = new ProcessBuilder("/system/bin/tar", "-xzf", tar.getAbsolutePath(), "-C",
                dest.getAbsolutePath()).redirectErrorStream(true).start();
        int code = p.waitFor();
        if (code != 0) {
            byte[] err = new byte[Math.min(p.getInputStream().available(), 4000)];
            p.getInputStream().read(err);
            android.util.Log.w("PiService", "tar exited " + code + " for " + name + ": " + new String(err));
            // toybox tar exits non-zero on dangling symlinks (harmless) — only
            // treat it as failure when expected files are missing
            if (!expectedFilesPresent(dest, name)) {
                throw new IOException("tar failed (" + code + ") for " + name + ": " + new String(err));
            }
        }
        tar.delete();
    }

    private static boolean expectedFilesPresent(File dest, String name) {
        if ("rootfs.bin".equals(name)) return new File(dest, "usr/bin/node").isFile();
        if ("runtime.bin".equals(name)) return new File(dest, "runtime/server.mjs").isFile();
        return true;
    }

    private static void deleteRecursive(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        f.delete();
    }
}
