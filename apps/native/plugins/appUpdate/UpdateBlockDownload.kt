package com.codexswitch.update

import android.os.SystemClock
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Small jobs let fast sources take more work; failed jobs leave completed file ranges intact. */
internal class UpdateBlockDownload(
  private val context: ReactApplicationContext, private val files: UpdateFiles, private val input: JSONObject,
) {
  private data class Result(val source: Int, val block: Int, val bytes: ByteArray?, val ready: Boolean = false)
  private val configs = input.getJSONArray("configs").also { require(it.length() in 0..3) }
  private val size = input.getLong("size").also { require(it in 1..MAX_UPDATE_BYTES) }
  private val count = ((size + UPDATE_BLOCK_BYTES - 1) / UPDATE_BLOCK_BYTES).toInt()
  private val plan = UpdateBlockPlan(count, configs.length() + 1)
  private val sessions = (0 until configs.length()).map { index ->
    UpdateBlockSession("update-${UUID.randomUUID()}", files, input, configs.getJSONObject(index))
  }
  private val ready = BooleanArray(configs.length() + 1)
  private val origin = UpdateOriginBlocks(files, input)
  private val executor = Executors.newFixedThreadPool(configs.length() + 1)
  private val tasks = ExecutorCompletionService<Result>(executor)
  private var pending = 0

  fun download(): String {
    require(configs.length() in 0..3 && size in 1..MAX_UPDATE_BYTES)
    require(files.artifact(input) == input.getString("artifact"))
    try {
      UpdateCheckpoint(files, input).use { checkpoint ->
        plan.restore(checkpoint.restored)
        sessions.indices.forEach { source -> submit(source, -1) { sessions[source].open(); null } }
        submit(sessions.size, -1) { if (sessions.isNotEmpty()) Thread.sleep(2_000); null }
        val deadline = SystemClock.elapsedRealtime() + 20 * 60_000
        while (!plan.complete() && pending > 0 && SystemClock.elapsedRealtime() < deadline) {
          val result = tasks.poll(250, TimeUnit.MILLISECONDS)?.get()
          if (result != null) { pending--; accept(result, checkpoint) }
          schedule()
        }
        check(plan.complete())
        return checkpoint.finish()
      }
    } finally {
      executor.shutdownNow()
      while (!executor.awaitTermination(1, TimeUnit.SECONDS)) { /* Wait before deleting a destination still in use. */ }
      sessions.forEach { it.close() }
    }
  }

  private fun submit(source: Int, index: Int, action: () -> ByteArray?) {
    pending++
    tasks.submit(Callable {
      try { Result(source, index, action(), index == -1) }
      catch (_: Exception) { Result(source, index, null) }
    })
  }

  private fun accept(result: Result, checkpoint: UpdateCheckpoint) {
    if (result.ready) { ready[result.source] = true; return }
    val bytes = result.bytes
    if (bytes == null) {
      plan.fail(result.source)
      if (result.source < sessions.size) {
        sessions[result.source].close()
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("updateSharingFailure", configs.getJSONObject(result.source).getString("sessionId"))
      }
      return
    }
    if (!plan.finish(result.source, result.block)) return
    checkpoint.write(result.block, bytes)
  }

  private fun schedule() {
    ready.indices.forEach { source ->
      if (!ready[source]) return@forEach
      val index = plan.claim(source, SystemClock.elapsedRealtime()) ?: return@forEach
      submit(source, index) {
        if (source == sessions.size) origin.block(index) else sessions[source].block(index)
      }
    }
  }
}

internal class UpdateBlockPlan(blocks: Int, sources: Int) {
  private val done = BooleanArray(blocks)
  private val busy = arrayOfNulls<Pair<Int, Long>>(sources)
  private val failed = BooleanArray(sources)
  fun complete() = done.all { it }
  fun restore(previous: BooleanArray) { require(previous.size == done.size); previous.copyInto(done) }
  fun fail(source: Int) { busy[source] = null; failed[source] = true }
  fun finish(source: Int, index: Int): Boolean {
    busy[source] = null
    if (done[index]) return false
    done[index] = true
    return true
  }
  fun claim(source: Int, now: Long): Int? {
    if (failed[source] || busy[source] != null) return null
    val pending = done.indices.firstOrNull { index -> !done[index] && busy.none { it?.first == index } }
    val steal = busy.filterNotNull().firstOrNull { (index, started) ->
      !done[index] && now - started >= 2_000 && busy.count { it?.first == index } == 1
    }?.first
    val index = pending ?: steal ?: return null
    busy[source] = index to now
    return index
  }
}
