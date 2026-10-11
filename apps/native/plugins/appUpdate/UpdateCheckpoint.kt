package com.codexswitch.update

import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/** Only completed, hashed blocks survive retries. The APK signature is still checked before publication. */
internal class UpdateCheckpoint(private val files: UpdateFiles, private val input: JSONObject) : Closeable {
  private val target = files.target(input.getString("path"))
  private val artifact = input.getString("artifact").also { require(it.matches(Regex("[0-9a-f]{64}"))) }
  private val size = input.getLong("size").also { require(it in 1..MAX_UPDATE_BYTES) }
  private val partial = files.target(File(target.parentFile, "CodexSwitch-update-partial-$artifact.apk").path)
  private val ledger = AtomicFile(File(partial.path + ".json"))
  private val file: RandomAccessFile
  private val hashes = arrayOfNulls<String>(((size + UPDATE_BLOCK_BYTES - 1) / UPDATE_BLOCK_BYTES).toInt())
  val restored: BooleanArray

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

  private fun length(index: Int) = minOf(UPDATE_BLOCK_BYTES.toLong(), size - index.toLong() * UPDATE_BLOCK_BYTES).toInt()
  private fun digest(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

  fun write(index: Int, bytes: ByteArray) {
    require(index in hashes.indices && bytes.size == length(index))
    file.seek(index.toLong() * UPDATE_BLOCK_BYTES); file.write(bytes); file.fd.sync()
    hashes[index] = digest(bytes)
    val metadata = JSONObject().put("artifact", artifact).put("size", size)
      .put("hashes", JSONArray(hashes.map { it ?: JSONObject.NULL }))
    val output = ledger.startWrite()
    try { output.write(metadata.toString().toByteArray(Charsets.UTF_8)); ledger.finishWrite(output) }
    catch (error: Exception) { ledger.failWrite(output); throw error }
  }

  fun finish(): String {
    file.close()
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

  override fun close() { file.close() }
}
