package dev.aimi.aimi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat

class AimiForegroundService : Service() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "aimi 守护", NotificationManager.IMPORTANCE_LOW),
        )
        startForeground(NOTIFICATION_ID, notification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    private fun notification(): Notification = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setContentTitle("aimi 在守护运行")
        .setContentText("会话连接与本地通知保持开启")
        .setOngoing(true)
        .build()

    companion object {
        const val CHANNEL_ID = "aimi.foreground"
        const val NOTIFICATION_ID = 2101
    }
}
