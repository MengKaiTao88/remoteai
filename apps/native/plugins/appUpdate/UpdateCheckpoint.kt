package com.codexswitch.update

// Match download storage; framework atomic commits can abort on affected HyperOS builds.
import androidx.core.util.AtomicFile
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/** Only completed, hashed blocks survive retries. The APK signature is still checked before publication. */
internal class UpdateCheckpoint(
  private val files: UpdateFiles, private val input: JSONObject,
  private val clock: () -> Long = SystemClock::elapsedRealtime,
) : Closeable {
  private val target = files.target(input.getString("path"))
  private val artifact = input.getString("artifact").also { require(it.matches(Regex("[0-9a-f]{64}"))) }
  private val size = input.getLong("size").also { require(it in 1..MAX_UPDATE_BYTES) }
  private val partial = files.target(File(target.parentFile, "CodexSwitch-update-partial-$artifact.apk").path)
  private val ledger = AtomicFile(File(partial.path + ".json"))
  private val file: RandomAccessFile
  private val hashes = arrayOfNulls<String>(((size + UPDATE_BLOCK_BYTES - 1) / UPDATE_BLOCK_BYTES).toInt())
  private var dirtyBytes = 0L
  private var savedAt = clock()
  private var closed = false
  val restored: BooleanArray
  val receivedBytes: Long get() = hashes.indices.sumOf { if (hashes[it] != null) length(it).toLong() else 0L }

  init {
    require(artifact.matches(Regex("[0-9a-f]{64}")) && size in 1..MAX_UPDATE_BYTES)
    prune()
    file = RandomAccessFile(partial, "rw")
    restore()
    file.setLength(size)
    restored = BooleanArray(hashes.size) { hashes[it] != null }
  }

  private fun restore() {
    if (file.length() != size || !ledger.baseFile.isFile || ledger.baseFile.length() > 128 * 1024) return
    try {
      val metadata = JSONObject(ledger.openRead().bufferedReader().use { it.readText() })
      if (metadata.optString("artifact") != artifact || metadata.optLong("size") != size) return
      val previous = metadata.getJSONArray("hashes")
      if (previous.length() != hashes.size) return
      for (index in hashes.indices) {
        val expected = previous.optString(index)
        if (!expected.matches(Regex("[0-9a-f]{64}"))) continue
        val bytes = ByteArray(length(index))
        file.seek(index.toLong() * UPDATE_BLOCK_BYTES); file.readFully(bytes)
        if (digest(bytes) == expected) hashes[index] = expected
      }
    } catch (_: Exception) { hashes.fill(null) }
  }

  private fun length(index: Int) =
    minOf(UPDATE_BLOCK_BYTES.toLong(), size - index.toLong() * UPDATE_BLOCK_BYTES).toInt()
  private fun digest(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

  fun write(index: Int, bytes: ByteArray) {
    require(index in hashes.indices && bytes.size == length(index))
    check(!closed)
    file.seek(index.toLong() * UPDATE_BLOCK_BYTES); file.write(bytes)
    hashes[index] = digest(bytes)
    dirtyBytes += bytes.size
    flushIfDue()
  }

  fun flushIfDue() {
    if (dirtyBytes >= CHECKPOINT_BYTES || clock() - savedAt >= CHECKPOINT_INTERVAL_MS) flush()
  }

  private fun flush() {
    if (dirtyBytes == 0L) return
    // As in download management, sync data before publishing a batched durable checkpoint.
    file.fd.sync()
    val metadata = JSONObject().put("artifact", artifact).put("size", size)
      .put("hashes", JSONArray(hashes.map { it ?: JSONObject.NULL }))
    val output = ledger.startWrite()
    try { output.write(metadata.toString().toByteArray(Charsets.UTF_8)) }
    catch (error: Exception) { ledger.failWrite(output); throw error }
    ledger.finishWrite(output)
    dirtyBytes = 0
    savedAt = clock()
  }

  fun finish(): String {
    close()
    val candidate = JSONObject(input.toString()).put("path", partial.path)
    if (!files.verify(candidate)) {
      ledger.delete(); partial.delete()
      error("Update integrity check failed")
    }
    if (target.exists()) check(target.delete())
    check(partial.renameTo(target))
    ledger.delete()
    return target.path
  }

  private fun prune() {
    target.parentFile?.listFiles()?.filter { it.isFile && it != partial
      && it.name.matches(Regex("CodexSwitch-update-partial-[0-9a-f]{64}\\.apk")) }
      ?.sortedByDescending { it.lastModified() }?.drop(1)?.forEach { file ->
        check(file.delete()); AtomicFile(File(file.path + ".json")).delete()
      }
  }

  override fun close() {
    if (closed) return
    try { flush() } finally { closed = true; file.close() }
  }

  private companion object {
    const val CHECKPOINT_BYTES = 4L * 1024 * 1024
    const val CHECKPOINT_INTERVAL_MS = 1_000L
  }
}
