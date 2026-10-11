package com.codexswitch.update

import android.os.SystemClock
import com.codexswitch.connectivity.NativeConnectivity
import org.json.JSONObject
import java.security.MessageDigest

internal const val UPDATE_BLOCK_BYTES = 512 * 1024

/** One negotiated binary session; payloads never cross the React Native bridge. */
internal class UpdateBlockSession(
  private val owner: String, private val files: UpdateFiles,
  private val input: JSONObject, private val config: JSONObject,
) {
  private var id: String? = null
  private var hashes = emptyList<String>()
  private val size = input.getLong("size")

  private fun active() {
    check(!Thread.currentThread().isInterrupted)
    if (input.optBoolean("wifiOnly")) check(files.wifiAvailable())
  }

  private fun call(request: JSONObject): Any? {
    val result = JSONObject(NativeConnectivity.call(request.put("owner", owner).toString()))
    check(!result.has("error"))
    return result.opt("data").takeUnless { it == JSONObject.NULL }
  }

  private fun event(): JSONObject? {
    active()
    return call(JSONObject().put("operation", "poll").put("id", id).put("wait_ms", 0)) as? JSONObject
  }

  private fun route(event: JSONObject) {
    val route = event.getJSONObject("route")
    check(route.optBoolean("direct"))
    if (input.optBoolean("wifiOnly")) check(files.wifiRoute(route))
  }

  fun open() {
    require(!config.getBoolean("desktop") && config.getString("sessionId").startsWith("update-"))
    id = call(JSONObject().put("operation", "open").put("config", config).put("packets", true)) as String
    val deadline = SystemClock.elapsedRealtime() + 12_000
    var opened = false
    var ready = false
    while (!ready && SystemClock.elapsedRealtime() < deadline) {
      val event = event()
      when (event?.optString("type")) {
        "open" -> opened = true
        "status" -> if (opened && event.getJSONObject("route").optBoolean("direct")) { route(event); ready = true }
        "closed", "data" -> error("Update connection unavailable")
        else -> Thread.sleep(10)
      }
    }
    check(ready)
    send(JSONObject().put("type", "describe").put("artifact", input.getString("artifact")))
    val manifest = message(SystemClock.elapsedRealtime() + 45_000)
    check(manifest.getString("type") == "manifest" && manifest.getLong("size") == size)
    val offered = manifest.getJSONArray("hashes")
    check(offered.length().toLong() == (size + UPDATE_BLOCK_BYTES - 1) / UPDATE_BLOCK_BYTES)
    hashes = (0 until offered.length()).map { offered.getString(it).also { hash ->
      check(hash.matches(Regex("[0-9a-f]{64}")))
    } }
  }

  private fun send(frame: JSONObject) {
    call(JSONObject().put("operation", "send").put("id", id).put("text", frame.toString()))
  }

  private fun message(deadline: Long): JSONObject {
    while (SystemClock.elapsedRealtime() < deadline) {
      val event = event()
      when (event?.optString("type")) {
        "data" -> return JSONObject(event.getString("text"))
        "closed", "open" -> error("Update connection interrupted")
        "status" -> route(event)
        else -> Thread.sleep(10)
      }
    }
    error("Update transfer timed out")
  }

  fun block(index: Int): ByteArray {
    val deadline = SystemClock.elapsedRealtime() + 25_000
    val length = minOf(UPDATE_BLOCK_BYTES.toLong(), size - index.toLong() * UPDATE_BLOCK_BYTES).toInt()
    require(index in hashes.indices && length > 0)
    send(JSONObject().put("type", "read").put("index", index))
    val header = message(deadline)
    check(header.getString("type") == "block" && header.getInt("index") == index && header.getInt("length") == length)
    val bytes = ByteArray(length)
    var offset = 0
    while (offset < length && SystemClock.elapsedRealtime() < deadline) {
      active()
      val packet = NativeConnectivity.receivePacket(owner, checkNotNull(id)) ?: error("Update connection interrupted")
      check(packet.size <= 64 * 1024 && packet.size <= length - offset)
      packet.copyInto(bytes, offset); offset += packet.size
      val status = event()
      when (status?.optString("type")) {
        "status" -> route(status)
        "closed", "open", "data" -> error("Update connection interrupted")
      }
    }
    check(offset == length && hex(MessageDigest.getInstance("SHA-256").digest(bytes)) == hashes[index])
    return bytes
  }

  fun close() {
    val handle = id ?: return
    id = null
    call(JSONObject().put("operation", "close").put("id", handle))
  }
}
