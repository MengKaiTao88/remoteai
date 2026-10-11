package com.codexswitch.update

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

internal class UpdateOriginBlocks(
  private val files: UpdateFiles, private val input: JSONObject,
) {
  fun block(index: Int): ByteArray {
    val url = input.getString("url")
    require(officialUrl(url))
    val size = input.getLong("size")
    val start = index.toLong() * UPDATE_BLOCK_BYTES
    val length = minOf(UPDATE_BLOCK_BYTES.toLong(), size - start).toInt()
    require(start >= 0 && length > 0)
    val connection = connection(url)
    try {
      connection.connectTimeout = 8_000
      connection.readTimeout = 8_000
      connection.setRequestProperty("Range", "bytes=$start-${start + length - 1}")
      connection.setRequestProperty("Accept-Encoding", "identity")
      check(connection.responseCode == HttpURLConnection.HTTP_PARTIAL)
      check(connection.getHeaderField("Content-Range") == "bytes $start-${start + length - 1}/$size")
      return read(connection, length)
    } finally { connection.disconnect() }
  }

  private fun connection(url: String): HttpURLConnection {
    if (!input.optBoolean("wifiOnly")) return URL(url).openConnection() as HttpURLConnection
    // Pin the request to Wi-Fi, so losing it cannot silently move a range request to mobile data.
    return checkNotNull(files.wifiNetwork()).openConnection(URL(url)) as HttpURLConnection
  }

  private fun read(connection: HttpURLConnection, length: Int): ByteArray {
    val bytes = ByteArray(length)
    connection.inputStream.use { stream ->
      var offset = 0
      while (offset < length) {
        check(!Thread.currentThread().isInterrupted)
        if (input.optBoolean("wifiOnly")) check(files.wifiAvailable())
        val count = stream.read(bytes, offset, minOf(64 * 1024, length - offset))
        check(count > 0); offset += count
      }
      check(stream.read() == -1)
    }
    return bytes
  }
}
