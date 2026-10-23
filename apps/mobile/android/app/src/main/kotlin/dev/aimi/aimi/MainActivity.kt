package dev.aimi.aimi

import io.flutter.embedding.android.FlutterActivity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "aimi/foreground_service")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "start" -> {
                        ContextCompat.startForegroundService(this, Intent(this, AimiForegroundService::class.java))
                        result.success(null)
                    }
                    "stop" -> {
                        stopService(Intent(this, AimiForegroundService::class.java))
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "aimi/install")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    // 调起系统包安装器安装 cacheDir 下的 APK（FileProvider 暴露 content URI）；
                    // 参数为 cacheDir 内相对文件名，不允许路径穿越。
                    "installApk" -> {
                        val name = call.argument<String>("name")
                        if (name == null || name.contains('/') || name.contains('\\') || name.contains("..")) {
                            result.error("bad_argument", "非法文件名", null)
                            return@setMethodCallHandler
                        }
                        val file = File(cacheDir, name)
                        if (!file.exists()) {
                            result.error("not_found", "APK 文件不存在", null)
                            return@setMethodCallHandler
                        }
                        val uri: Uri = FileProvider.getUriForFile(
                            this, "$packageName.fileprovider", file
                        )
                        val intent = Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, "application/vnd.android.package-archive")
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        startActivity(intent)
                        result.success(null)
                    }
                    // 是否已授予"允许此来源安装未知应用"（Android 8+ 未知来源安装闸门）。
                    "canRequestPackageInstalls" -> {
                        result.success(
                            Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
                                packageManager.canRequestPackageInstalls()
                        )
                    }
                    // 引导跳转系统设置页开启"允许安装未知应用"；调用方先经 canRequestPackageInstalls 判定。
                    "openUnknownAppSourcesSettings" -> {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            val intent = Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:$packageName")
                            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            startActivity(intent)
                        }
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }
}
