package com.codexswitch.update

import android.os.SystemClock
import org.json.JSONObject
import java.net.HttpURLConnection
import java.security.MessageDigest

object UpdateDownloadProbe {
  @JvmStatic fun main(args: Array<String>) {
    UpdateSnapshotChecks.run()
    UpdateCancellationChecks.run()
    UpdateOriginChecks.run()
    UpdatePipelineChecks.run()
    DownloadCheckpointChecks.run()
    UpdateStorageChecks.run()
    if (args.isNotEmpty()) downloadRelease(args)
    // Some phones retain a network helper thread after all synchronous checks and cleanup have finished.
    kotlin.system.exitProcess(0)
  }

  private fun downloadRelease(args: Array<String>) = UpdateTestStorage().use { storage ->
    val size = args[1].toLong()
    val input = storage.input(size.toInt()).put("url", args[0]).put("wifiOnly", false)
    val started = SystemClock.elapsedRealtime()
    var received = 0L
    var requests = 0
    UpdateOriginBlocks(storage.files, input, openConnection = { url ->
      requests++
      val target = if (args.size > 3) java.net.URL(args[3]) else url
      target.openConnection() as HttpURLConnection
    }).use { download ->
      UpdateCheckpoint(storage.files, input).use { checkpoint ->
        received = receive(download, checkpoint, size) { report(it, started, requests) }
      }
    }
    val digest = MessageDigest.getInstance("SHA-256")
    storage.partial(input).inputStream().use { stream ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = stream.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    check(received == size && storage.partial(input).length() == size && hex(digest.digest()) == args[2])
    check(requests == ((size + UPDATE_ORIGIN_REQUEST_BYTES - 1) / UPDATE_ORIGIN_REQUEST_BYTES).toInt())
    report(received, started, requests)
    val label = if (args.size > 3) "local fixture" else "official APK"
    println("PASS: complete $label, expected SHA-256 matched, continuous 8 MiB HTTP responses")
  }

  private fun receive(download: UpdateOriginBlocks, checkpoint: UpdateCheckpoint,
    size: Long, progress: (Long) -> Unit): Long {
    var received = 0L
    val blocks = ((size + UPDATE_BLOCK_BYTES - 1) / UPDATE_BLOCK_BYTES).toInt()
    repeat(blocks) { index ->
      val bytes = download.block(index)
      checkpoint.write(index, bytes)
      received += bytes.size
      if ((index + 1) % REPORT_BLOCKS == 0 || received == size) progress(received)
    }
    return received
  }

  private fun report(received: Long, started: Long, requests: Int) {
    val elapsed = (SystemClock.elapsedRealtime() - started).coerceAtLeast(1)
    println(JSONObject().put("bytes", received).put("ms", elapsed).put("requests", requests)
      .put("KiBps", received * 1000 / elapsed / 1024))
  }

  private const val REPORT_BLOCKS = 16
}
