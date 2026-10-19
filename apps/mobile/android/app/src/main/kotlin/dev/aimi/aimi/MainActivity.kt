package dev.aimi.aimi

import io.flutter.embedding.android.FlutterActivity
import android.content.Intent
import androidx.core.content.ContextCompat
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

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
    }
}
