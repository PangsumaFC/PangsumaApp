package com.pangsuma.fc;

import android.app.Activity;
import android.content.Intent;
import android.app.DownloadManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.Toast;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final String START_URL = "https://app.pangsumafc.com/";
    private static final String APP_HOST = "app.pangsumafc.com";
    private static final int REQUEST_CREATE_CSV = 7412;
    private static final int REQUEST_PICK_PHOTO = 7413;
    private static final Pattern ALLOWED_CSV_NAME = Pattern.compile(
            "pangsuma-rekap-lengkap-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.csv");
    private static final String CSV_EXPORT_HOOK = "(function(){"
            + "if(window.__pangsumaCsvExportHook)return;"
            + "window.__pangsumaCsvExportHook=true;"
            + "document.addEventListener('click',function(event){"
            + "var target=event.target;"
            + "var link=target&&target.closest?target.closest('a[download]'):null;"
            + "if(!link||!link.href||!link.href.startsWith('blob:'))return;"
            + "var name=link.getAttribute('download')||'';"
            + "if(!name.startsWith('pangsuma-rekap-lengkap-'))return;"
            + "event.preventDefault();event.stopImmediatePropagation();"
            + "fetch(link.href).then(function(response){return response.blob();})"
            + ".then(function(blob){var reader=new FileReader();"
            + "reader.onload=function(){window.PangsumaFileBridge.saveCsv(name,String(reader.result));};"
            + "reader.onerror=function(){window.PangsumaFileBridge.reportError();};"
            + "reader.readAsDataURL(blob);})"
            + ".catch(function(){window.PangsumaFileBridge.reportError();});"
            + "},true);})();";

    private WebView webView;
    private byte[] pendingCsv;
    private String pendingCsvName;
    private ValueCallback<Uri[]> pendingFileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(242, 244, 246));
        getWindow().setNavigationBarColor(Color.rgb(242, 244, 246));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(242, 244, 246));
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        // ACTION_OPEN_DOCUMENT returns content:// Uris; WebView must be allowed to read
        // content-backed resources when the page submits the selected photo.
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);

        CookieManager.getInstance().setAcceptCookie(true);
        webView.addJavascriptInterface(new CsvBridge(), "PangsumaFileBridge");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (!isAllowedAppUri(Uri.parse(view.getUrl() == null ? "" : view.getUrl()))
                        || !acceptsImage(params) || !isOpenSingleFileMode(params)) {
                    callback.onReceiveValue(null);
                    return true;
                }
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
                try {
                    startActivityForResult(intent, REQUEST_PICK_PHOTO);
                } catch (Exception error) {
                    pendingFileCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "Pemilih foto tidak tersedia.",
                            Toast.LENGTH_LONG).show();
                }
                return true;
            }
        });
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                    String mimeType, long contentLength) {
                handleCsvDownload(url, userAgent, contentDisposition, mimeType);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if (isAllowedAppUri(uri)) {
                    return false;
                }
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)
                        || "mailto".equalsIgnoreCase(scheme) || "tel".equalsIgnoreCase(scheme)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                        return true;
                    } catch (Exception ignored) {
                        return false;
                    }
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Uri uri = Uri.parse(url);
                if (isAllowedAppUri(uri)) {
                    view.evaluateJavascript("window.__pangsumaNativeDownloads=true;" + CSV_EXPORT_HOOK,
                            null);
                }
            }
        });

        // Start from the live origin on every new Activity launch; no web app files or data are bundled.
        webView.loadUrl(START_URL);
    }

    public final class CsvBridge {
        @JavascriptInterface
        public void saveCsv(String filename, String dataUrl) {
            if (filename == null || !ALLOWED_CSV_NAME.matcher(filename).matches()
                    || dataUrl == null || dataUrl.length() > 28_000_000) {
                reportError();
                return;
            }
            String lower = dataUrl.toLowerCase(Locale.ROOT);
            int comma = dataUrl.indexOf(',');
            if (comma < 0 || !(lower.startsWith("data:text/csv")
                    || lower.startsWith("data:application/csv"))) {
                reportError();
                return;
            }
            final byte[] bytes;
            try {
                bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            } catch (IllegalArgumentException error) {
                reportError();
                return;
            }
            if (bytes.length > 20_000_000) {
                reportError();
                return;
            }
            runOnUiThread(() -> requestCsvDestination(filename, bytes));
        }

        @JavascriptInterface
        public void reportError() {
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    "Ekspor CSV tidak berhasil disiapkan.", Toast.LENGTH_LONG).show());
        }
    }

    private void requestCsvDestination(String filename, byte[] bytes) {
        if (pendingCsv != null) {
            Toast.makeText(this, "Selesaikan atau batalkan ekspor sebelumnya terlebih dahulu.",
                    Toast.LENGTH_LONG).show();
            return;
        }
        pendingCsvName = filename;
        pendingCsv = bytes;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("text/csv");
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        try {
            startActivityForResult(intent, REQUEST_CREATE_CSV);
        } catch (Exception error) {
            pendingCsv = null;
            pendingCsvName = null;
            Toast.makeText(this, "Pemilih lokasi penyimpanan tidak tersedia.",
                    Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_PICK_PHOTO) {
            ValueCallback<Uri[]> callback = pendingFileCallback;
            pendingFileCallback = null;
            if (callback != null) {
                Uri result = resultCode == RESULT_OK && data != null ? data.getData() : null;
                if (result == null || !isAllowedPhotoUri(result)) {
                    callback.onReceiveValue(null);
                } else {
                    callback.onReceiveValue(new Uri[] {result});
                }
            }
            return;
        }
        if (requestCode != REQUEST_CREATE_CSV) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null || pendingCsv == null) {
            clearPendingCsv();
            return;
        }

        Uri destination = data.getData();
        byte[] bytes = pendingCsv;
        String filename = pendingCsvName;
        clearPendingCsv();
        new Thread(() -> {
            boolean saved = false;
            try (OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                if (output != null) {
                    output.write(bytes);
                    output.flush();
                    saved = true;
                }
            } catch (IOException ignored) {
                saved = false;
            }
            final boolean success = saved;
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    success ? "Rekap CSV tersimpan: " + filename : "CSV tidak dapat disimpan.",
                    Toast.LENGTH_LONG).show());
        }, "pangsuma-csv-save").start();
    }

    private void clearPendingCsv() {
        pendingCsv = null;
        pendingCsvName = null;
    }

    private static boolean isAllowedAppUri(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                && APP_HOST.equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443)
                && (uri.getUserInfo() == null || uri.getUserInfo().isEmpty());
    }

    private static boolean acceptsImage(WebChromeClient.FileChooserParams params) {
        String[] types = params == null ? null : params.getAcceptTypes();
        if (types == null || types.length == 0) return true;
        for (String type : types) {
            if (isAllowedImageMime(type) || "image/*".equalsIgnoreCase(trimMime(type))) return true;
        }
        return false;
    }

    private static boolean isOpenSingleFileMode(WebChromeClient.FileChooserParams params) {
        return params == null || params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN;
    }

    private static String trimMime(String mimeType) {
        return mimeType == null ? "" : mimeType.trim().toLowerCase(Locale.ROOT);
    }

    private static boolean isAllowedImageMime(String mimeType) {
        String normalized = trimMime(mimeType);
        return "image/jpeg".equals(normalized) || "image/png".equals(normalized)
                || "image/webp".equals(normalized);
    }

    private boolean isAllowedPhotoUri(Uri uri) {
        if (uri == null || !"content".equalsIgnoreCase(uri.getScheme())) return false;
        String mimeType = getContentResolver().getType(uri);
        return isAllowedImageMime(mimeType);
    }

    private void handleCsvDownload(String url, String userAgent, String contentDisposition,
            String mimeType) {
        Uri uri = Uri.parse(url == null ? "" : url);
        if (!isAllowedCsvDownloadUri(uri)
                || (mimeType != null && !mimeType.toLowerCase(Locale.ROOT).startsWith("text/csv"))) {
            Toast.makeText(this, "Unduhan CSV ditolak.", Toast.LENGTH_LONG).show();
            return;
        }
        String cookie = CookieManager.getInstance().getCookie(uri.toString());
        if (cookie == null || cookie.isEmpty()) {
            Toast.makeText(this, "Sesi login tidak tersedia untuk unduhan CSV.",
                    Toast.LENGTH_LONG).show();
            return;
        }
        Matcher matcher = Pattern.compile("filename\\s*=\\s*\\\"?([^\\\";]+)",
                Pattern.CASE_INSENSITIVE).matcher(contentDisposition == null ? "" : contentDisposition);
        String filename = matcher.find() ? matcher.group(1).trim() : "";
        if (!ALLOWED_CSV_NAME.matcher(filename).matches()) {
            Toast.makeText(this, "Nama file CSV tidak valid.", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(uri);
            request.addRequestHeader("Cookie", cookie);
            if (userAgent != null && !userAgent.isEmpty()) {
                request.addRequestHeader("User-Agent", userAgent);
            }
            request.setMimeType("text/csv");
            request.setTitle(filename);
            request.setDescription("Ekspor CSV Pangsuma");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("download manager unavailable");
            manager.enqueue(request);
            Toast.makeText(this, "Permintaan unduh CSV dikirim.", Toast.LENGTH_LONG).show();
        } catch (RuntimeException error) {
            Toast.makeText(this, "Unduhan CSV tidak dapat dimulai.", Toast.LENGTH_LONG).show();
        }
    }

    private static boolean isAllowedCsvDownloadUri(Uri uri) {
        return isAllowedAppUri(uri) && "/api/export.csv".equals(uri.getPath())
                && (uri.getQuery() == null || uri.getQuery().isEmpty());
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = null;
            }
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.removeJavascriptInterface("PangsumaFileBridge");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
