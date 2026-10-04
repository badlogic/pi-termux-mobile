package org.pimobile.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileInputStream;

public final class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.setWebChromeClient(new android.webkit.WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    // bridge may be restarting on a new port — poll again
                    new Thread(MainActivity.this::waitForBridge, "pi-bridge-wait2").start();
                }
            }
        });
        setContentView(webView);

        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(new Intent(this, PiService.class));
        } else {
            startService(new Intent(this, PiService.class));
        }

        new Thread(this::waitForBridge, "pi-bridge-wait").start();
    }

    private void waitForBridge() {
        // server.mjs writes under $HOME/.pi-mobile (HOME == files/home)
        File stateDir = new File(new File(getFilesDir(), "home"), ".pi-mobile");
        File portFile = new File(stateDir, "port");
        File tokenFile = new File(stateDir, "token");
        for (int i = 0; i < 120; i++) {
            try {
                if (portFile.isFile() && tokenFile.isFile()) {
                    String port = readAll(portFile).trim();
                    String token = readAll(tokenFile).trim();
                    if (!port.isEmpty()) {
                        String url = "http://127.0.0.1:" + port + "/?token=" + token;
                        runOnUiThread(() -> webView.loadUrl(url));
                        return;
                    }
                }
                Thread.sleep(500);
            } catch (Exception ignored) {}
        }
        runOnUiThread(() -> webView.loadData(
                "<body style='background:#101014;color:#e4e4e8;font-family:sans-serif'>"
                        + "<h3>runtime failed to start</h3>"
                        + "<p>Check that the device allows the process; see README.</p></body>",
                "text/html", "utf-8"));
    }

    private static String readAll(File f) throws Exception {
        byte[] b = new byte[(int) f.length()];
        try (FileInputStream in = new FileInputStream(f)) {
            int off = 0;
            while (off < b.length) {
                int n = in.read(b, off, b.length - off);
                if (n < 0) break;
                off += n;
            }
        }
        return new String(b, "UTF-8");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
