package dental.serene.pager

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The tablet restarted (power cut, update): be a station again without anyone opening the app. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) PagerService.start(ctx)
    }
}
