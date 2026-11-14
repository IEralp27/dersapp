// DersApp telefon eklentisi (Android). Rust tarafı: ../../../../src/lib.rs (`Mobil::call`), komutları
// kullanan uygulama kodu: src-tauri/src/mobile/ (saf.rs: klasör, ses.rs: seslendirme, web.rs: bağlantı).
//
// - Klasör: Storage Access Framework (ACTION_OPEN_DOCUMENT_TREE). Kalıcı okuma izni alınır; klasör ağacı
//   (kök + iki alt düzey) listelenir; dosya içerik çözücüyle (content resolver) okunup verilen yola kopyalanır.
// - Seslendirme: Android TextToSpeech (telefonun motoru: Google, Samsung...). Türkçe sesler listelenir;
//   cümle synthesizeToFile ile WAV dosyasına yazılır (arayüz baytları kendi oynatıcısıyla çalar).
// - Bağlantı: ACTION_VIEW ile telefonun tarayıcısında açılır.
package com.eralp.dersapp.mobil

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

@InvokeArg
class TreeArgs {
  lateinit var tree: String
  var depth: Int = 3
}

@InvokeArg
class CopyArgs {
  lateinit var uri: String
  lateinit var dest: String
}

@InvokeArg
class SynthArgs {
  lateinit var text: String
  var voice: String? = null
  lateinit var dest: String
}

@InvokeArg
class UrlArgs {
  lateinit var url: String
}

private const val MAX_ENTRIES = 3000
private val TR: Locale = Locale.forLanguageTag("tr-TR")

@TauriPlugin
class MobilPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())

  // ================================================================ Klasör (SAF)

  @Command
  fun pickFolder(invoke: Invoke) {
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      startActivityForResult(invoke, intent, "folderPicked")
    } catch (e: Exception) {
      invoke.reject("Klasör seçici açılamadı: " + (e.message ?: ""))
    }
  }

  @ActivityCallback
  fun folderPicked(invoke: Invoke, result: ActivityResult) {
    val uri = result.data?.data
    val r = JSObject()
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolve(r) // vazgeçildi: tree yok
      return
    }
    try {
      activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    } catch (e: Exception) {
      invoke.reject("Klasör için kalıcı okuma izni alınamadı: " + (e.message ?: ""))
      return
    }
    r.put("tree", uri.toString())
    r.put("name", treeName(uri))
    invoke.resolve(r)
  }

  private fun treeName(tree: Uri): String {
    try {
      val doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
      activity.contentResolver.query(doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val n = c.getString(0)
          if (n != null) return n
        }
      }
    } catch (e1: Exception) {
    }
    return "Klasör"
  }

  @Command
  fun listTree(invoke: Invoke) {
    val args = invoke.parseArgs(TreeArgs::class.java)
    Thread {
      try {
        val tree = Uri.parse(args.tree)
        val out = JSArray()
        walk(tree, DocumentsContract.getTreeDocumentId(tree), "", 1, args.depth, out)
        val r = JSObject()
        r.put("entries", out)
        invoke.resolve(r)
      } catch (e: SecurityException) {
        invoke.reject("Klasör izni artık yok. \"Klasör seç\" ile klasörü yeniden seç.")
      } catch (e: Exception) {
        invoke.reject("Klasör okunamadı: " + (e.message ?: ""))
      }
    }.start()
  }

  private fun wanted(name: String): Boolean {
    val n = name.lowercase(Locale.ROOT)
    return n.endsWith(".pdf") || n.endsWith(".pptx")
  }

  /** Klasörün çocuklarını `out`a ekler; alt klasörlere `maxLevel`e kadar iner. rel: kökten "/" ile ayrılmış yol. */
  private fun walk(tree: Uri, docId: String, prefix: String, level: Int, maxLevel: Int, out: JSArray) {
    if (out.length() >= MAX_ENTRIES) return
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
    val cols = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )
    val dirs = ArrayList<Pair<String, String>>()
    val cursor = activity.contentResolver.query(children, cols, null, null, null) ?: return
    cursor.use { c ->
      while (c.moveToNext() && out.length() < MAX_ENTRIES) {
        val id = c.getString(0)
        val name = c.getString(1)
        if (id != null && name != null && !name.startsWith(".")) {
          val isDir = c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR
          if (isDir && level < maxLevel || !isDir && wanted(name)) {
            val o = JSObject()
            o.put("rel", prefix + name)
            o.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString())
            o.put("dir", isDir)
            o.put("size", if (c.isNull(3)) 0L else c.getLong(3))
            o.put("modified", if (c.isNull(4)) 0L else c.getLong(4))
            out.put(o)
            if (isDir) dirs.add(Pair(id, "$prefix$name/"))
          }
        }
      }
    }
    for (d in dirs) walk(tree, d.first, d.second, level + 1, maxLevel, out)
  }

  /** Belgeyi içerik çözücüyle okuyup `dest` yoluna yazar (önce geçici dosyaya, sonra adını değiştirir). */
  @Command
  fun copyFile(invoke: Invoke) {
    val args = invoke.parseArgs(CopyArgs::class.java)
    Thread {
      try {
        val dest = File(args.dest)
        dest.parentFile?.mkdirs()
        val tmp = File(dest.path + ".tmp-yaz")
        val input = activity.contentResolver.openInputStream(Uri.parse(args.uri))
          ?: throw Exception("dosya açılamadı")
        var n = 0L
        input.use { i -> FileOutputStream(tmp).use { o -> n = i.copyTo(o) } }
        if (dest.exists()) dest.delete()
        if (!tmp.renameTo(dest)) throw Exception("kopya yerine konamadı")
        val r = JSObject()
        r.put("size", n)
        invoke.resolve(r)
      } catch (e: SecurityException) {
        invoke.reject("Klasör izni artık yok. \"Klasör seç\" ile klasörü yeniden seç.")
      } catch (e: Exception) {
        invoke.reject("Dosya okunamadı: " + (e.message ?: ""))
      }
    }.start()
  }

  // ================================================================ Bağlantı

  @Command
  fun openUrl(invoke: Invoke) {
    val args = invoke.parseArgs(UrlArgs::class.java)
    try {
      val i = Intent(Intent.ACTION_VIEW, Uri.parse(args.url))
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(i)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Bağlantı açılamadı: " + (e.message ?: ""))
    }
  }

  // ================================================================ Seslendirme (TextToSpeech)

  private var tts: TextToSpeech? = null
  /** 0: başlatılmadı, 1: başlatılıyor, 2: hazır */
  private var ttsState = 0
  private val waiters = ArrayList<() -> Unit>()
  private val pending = ConcurrentHashMap<String, Invoke>()
  private var seq = 0L

  private val listener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {}

    override fun onDone(utteranceId: String?) {
      if (utteranceId != null) pending.remove(utteranceId)?.resolve()
    }

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String?) {
      if (utteranceId != null) pending.remove(utteranceId)?.reject("Telefonun seslendiricisi bu cümleyi okuyamadı.")
    }

    override fun onError(utteranceId: String?, errorCode: Int) {
      if (utteranceId != null) pending.remove(utteranceId)?.reject("Telefonun seslendiricisi bu cümleyi okuyamadı (hata $errorCode).")
    }
  }

  /** Motor hazırsa `run`ı ana iş parçacığında çalıştırır; değilse başlatır ve hazır olunca çalıştırır. */
  private fun withTts(invoke: Invoke, run: (TextToSpeech) -> Unit) {
    main.post {
      val job = {
        val t = tts
        if (ttsState == 2 && t != null) {
          try {
            run(t)
          } catch (e: Exception) {
            invoke.reject("Seslendirme hatası: " + (e.message ?: ""))
          }
        } else {
          invoke.reject("Telefonda seslendirme motoru bulunamadı ya da başlatılamadı. Ayarlar > Erişilebilirlik > Metin okuma çıkışı bölümüne bak.")
        }
      }
      if (ttsState == 2) {
        job()
      } else {
        waiters.add(job)
        if (ttsState == 0) {
          ttsState = 1
          tts = TextToSpeech(activity.applicationContext) { status ->
            main.post {
              if (status == TextToSpeech.SUCCESS) {
                ttsState = 2
                tts?.setOnUtteranceProgressListener(listener)
              } else {
                ttsState = 0
                try {
                  tts?.shutdown()
                } catch (e2: Exception) {
                }
                tts = null
              }
              val w = ArrayList(waiters)
              waiters.clear()
              for (f in w) f()
            }
          }
        }
      }
    }
  }

  /** Motor adı, Türkçe dil durumu (TextToSpeech.LANG_*) ve Türkçe sesler. */
  @Command
  fun ttsInfo(invoke: Invoke) {
    withTts(invoke) { t ->
      val r = JSObject()
      r.put("engine", t.defaultEngine ?: "")
      r.put("lang", t.isLanguageAvailable(TR))
      val arr = JSArray()
      val voices = try {
        t.voices
      } catch (e3: Exception) {
        null
      }
      if (voices != null) {
        for (v in voices) {
          if (v.locale.language != "tr") continue
          val o = JSObject()
          o.put("id", v.name)
          o.put("quality", v.quality)
          o.put("network", v.isNetworkConnectionRequired)
          val f = v.features
          o.put("installed", f == null || !f.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED))
          arr.put(o)
        }
      }
      r.put("voices", arr)
      invoke.resolve(r)
    }
  }

  /** Metni `dest` yoluna ses dosyası olarak yazar; dosya bitince yanıt verir. Hız 1: hız oynatırken uygulanır. */
  @Command
  fun ttsSynth(invoke: Invoke) {
    val args = invoke.parseArgs(SynthArgs::class.java)
    withTts(invoke) { t ->
      val want = args.voice
      val voice = if (want.isNullOrEmpty()) null else (try { t.voices } catch (e4: Exception) { null })?.firstOrNull { it.name == want }
      if (voice != null) t.setVoice(voice) else t.setLanguage(TR)
      t.setSpeechRate(1.0f)
      t.setPitch(1.0f)
      seq += 1
      val id = "d$seq"
      val f = File(args.dest)
      f.parentFile?.mkdirs()
      pending[id] = invoke
      val res = t.synthesizeToFile(args.text, Bundle(), f, id)
      if (res != TextToSpeech.SUCCESS) {
        pending.remove(id)
        invoke.reject("Telefonun seslendiricisi ses üretemedi.")
      } else {
        main.postDelayed({ pending.remove(id)?.reject("Telefonun seslendiricisi yanıt vermedi.") }, 60_000)
      }
    }
  }

  override fun onDestroy() {
    try {
      tts?.shutdown()
    } catch (e5: Exception) {
    }
    tts = null
    ttsState = 0
  }
}
