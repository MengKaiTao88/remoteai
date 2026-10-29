package com.codexswitch.update

import com.codexswitch.downloads.BulkDownloadStorage
import com.codexswitch.downloads.DownloadStorage
import com.codexswitch.downloads.DownloadTask
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** Replays login-time saves and checkpoint recovery using the production Android storage classes. */
internal object DownloadCheckpointChecks {
  private const val SAVE_ROUNDS = 128

  fun run() {
    repeatedLoginCheckpoints()
    interruptedCheckpointPreservesTasks()
    failedWritePreservesTasks()
    hashPagesSurviveReplacement()
    println("PASS: repeated login checkpoints, interrupted/failed writes and hash-page replacement")
  }

  private fun task(): DownloadTask = DownloadTask.create(JSONObject().put("owner", "checkpoint-test")
    .put("deviceId", "pc").put("scope", "computer").put("path", "resume.bin"))

  private fun repeatedLoginCheckpoints() = UpdateTestStorage().use { fixture ->
    repeat(SAVE_ROUNDS) {
      val storage = DownloadStorage(fixture.context)
      storage.save(emptyList())
      check(storage.load().isEmpty())
    }
    val index = File(fixture.context.filesDir, "managed-downloads/tasks.json")
    check(index.readText() == "[]" && !File(index.path + ".new").exists())
  }

  private fun interruptedCheckpointPreservesTasks() = UpdateTestStorage().use { fixture ->
    val storage = DownloadStorage(fixture.context)
    val task = task()
    storage.prepare(task)
    storage.append(task, byteArrayOf(1, 2, 3))
    storage.save(listOf(task))
    val index = File(fixture.context.filesDir, "managed-downloads/tasks.json")
    File(index.path + ".new").writeText("[{\"id\":")
    val restored = DownloadStorage(fixture.context).load().getValue(task.id)
    check(restored.status == "paused" && restored.received == 3L)
    check(!File(index.path + ".new").exists())
    storage.append(task, byteArrayOf(4))
    storage.save(listOf(task))
    check(DownloadStorage(fixture.context).load().getValue(task.id).received == 4L)
  }

  private fun failedWritePreservesTasks() = UpdateTestStorage().use { fixture ->
    val storage = DownloadStorage(fixture.context)
    val task = task()
    storage.save(listOf(task))
    val index = File(fixture.context.filesDir, "managed-downloads/tasks.json")
    val previous = index.readText()
    val pending = File(index.path + ".new")
    check(pending.mkdir())
    try {
      storage.save(emptyList())
      error("An unwritable checkpoint must fail")
    } catch (_: IOException) {
      check(index.readText() == previous)
    }
    check(pending.delete())
    check(storage.load().keys == setOf(task.id))
  }

  private fun hashPagesSurviveReplacement() = UpdateTestStorage().use { fixture ->
    val storage = DownloadStorage(fixture.context)
    val task = task()
    repeat(SAVE_ROUNDS) { round ->
      val page = JSONObject().put("page", 0).put("generation", round)
      BulkDownloadStorage(storage).storePage(task, page.toString())
      check(BulkDownloadStorage(storage).page(task, 0).getInt("generation") == round)
    }
  }
}
