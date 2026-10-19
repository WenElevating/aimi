package dev.aimi.aimi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class AimiBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        ContextCompat.startForegroundService(
            context,
            Intent(context, AimiForegroundService::class.java),
        )
    }
}
