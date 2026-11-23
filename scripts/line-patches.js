'use strict';

// Local additions to the reference backend, applied with go build -overlay.
function patchFile(file, source) {
  const change = (before, after) => {
    if (!source.includes(before)) throw new Error(`LINE backend changed: missing patch location in ${file}`);
    source = source.replace(before, after);
  };
  if (file === 'internal/events/watch.go') {
    change(
      'type Event struct {',
      `type Event struct {
 ReaderID string \`json:"readerId,omitempty"\`
 MessageID string \`json:"messageId,omitempty"\``,
    );
    change(
      'if (op.Type == 25 || op.Type == 26)',
      `// Media completion and preview hints change messages, not account metadata.
    // Preserve explicit fullSync/unknown-operation handling below.
    if op.Type == 27 || op.Type == 29 || op.Type == 43 || op.Type == 45 {
      event.Event = "media"
      if messaging.ValidateChatID(op.Param1) == nil { event.ChatID = op.Param1 }
      for _, value := range []string{op.Param2, op.Param1, op.Param3} {
        if messaging.ValidateMessageID(value) == nil { event.MessageID = value; break }
      }
      if op.Type == 43 && op.Message != nil && messaging.ValidateChatID(op.Message.To) == nil &&
         messaging.ValidateMessageID(op.Message.ID) == nil {
        msg := decoder.Decode(op.Message.To, op.Message)
        event.ChatID, event.MessageID, event.Message = op.Message.To, msg.ID, &msg
      }
      return event, next, nil
    }
    if op.Type == 55 {
      event.Event, event.ChatID, event.ReaderID, event.MessageID = "read", op.Param1, op.Param2, op.Param3
    }
    if (op.Type == 25 || op.Type == 26)`,
    );
  }
  if (file === 'internal/gui/engine.go') {
    change(
      'type View struct {',
      `type View struct {
 UploadPending bool \`json:"uploadPending"\`
 SentAttachmentID string \`json:"sentAttachmentId"\``,
    );
    change(
      'e.state.Login.Active || e.pending || !slices.ContainsFunc',
      'e.state.Login.Active || (e.pending && !e.state.UploadPending) || !slices.ContainsFunc',
    );
    change(
      'ctx := e.resourceCtx\n\tmode := e.state.Mode\n\tdraft := c.Text',
      `ctx := e.resourceCtx
 cancelSend := func() {}
 if attachment != nil {
   ctx, cancelSend = context.WithTimeout(ctx, 90*time.Second)
 }
 e.state.UploadPending = attachment != nil
 e.state.SentAttachmentID = ""
 mode := e.state.Mode
 draft := c.Text`,
    );
    change('var result SendResult\n\t\tvar err error', 'defer cancelSend()\n var result SendResult\n var err error');
    change(
      'e.pending = false\n\t\tif errors.Is(err, ErrUnauthenticated)',
      'e.pending = false\n e.state.UploadPending = false\n if errors.Is(err, ErrUnauthenticated)',
    );
    change(
      'e.state.SendStatus = "idle"\n\t\tnow := time.Now()',
      `e.state.SendStatus = "idle"
 if attachment != nil { e.state.SentAttachmentID = attachment.ID }
 now := time.Now()`,
    );
    change('type Attachment struct {', 'type Attachment struct {\n Image bool `json:"image"`');
    change(
      'e.mu.Lock()\n\t\tdefer e.mu.Unlock()\n\t\te.mutationActive = false',
      `sentThumb := ""
 if err == nil && attachment != nil && attachment.Image { sentThumb = photoThumbnail(attachment.Data) }
 e.mu.Lock()
 defer e.mu.Unlock()
 e.mutationActive = false`,
    );
    change(
      'e.sentMessage(c.ID, item)',
      `e.sentMessage(c.ID, item)
 if attachment != nil && attachment.Image { e.seedSentPhoto(c.ID, item.ID, sentThumb) }`,
    );
    change(
      'e.state.SendNote = "送信結果を確認できません。LINE側で確認してから、必要な場合だけ再送してください"',
      `e.state.SendNote = "送信結果を確認できません。LINE側で確認してから、必要な場合だけ再送してください"
 if attachment != nil && attachment.Image {
   e.state.SendNote = "Delivery unconfirmed: " + photoFailureSummary(err) + "; check LINE before retrying"
 }`,
    );
    change(
      'item.ContentType = 14',
      `item.ContentType = 14
 if attachment.Image { item.ContentType = 1; item.Text = "［画像］" }`,
    );
    change(
      'type Chat struct {',
      `type Chat struct {
 Muted bool \`json:"muted"\`
 MuteKnown bool \`json:"-"\`
 NotificationLastID string \`json:"-"\``,
    );
    change(
      'type Operations struct {',
      `type Operations struct {
 SetMuted func(context.Context, string, bool) error
 MarkRead func(context.Context, string, string) error
 NotifyDiagnostic func(context.Context, string, string) string
 CacheDir string
 MediaDir string`,
    );
    change(
      'type Engine struct {',
      `type Engine struct {
 muteBusy map[string]bool
 readCursors map[string]string
 readQueue Command
 readActive bool
 readCancel context.CancelFunc
 readViewFocused bool
 mediaStore *mediaCache
 notificationTestActive bool
 notificationChats map[string]string
 notificationInitial map[string]string
 notificationQueue map[string]string
 notificationScanActive bool
 notificationSeen map[string]bool
 notificationOrder []string
 historyStore *historyCache
 historyCached []Message
 historyEnd int`,
    );
    change('e.resetPhotos()\n\tchanged :=', 'e.cancelReadView()\n e.resetPhotos()\n\tchanged :=');
    change(
      'func (e *Engine) resetIdentity() {',
      `func (e *Engine) resetIdentity() {
 e.state.UploadPending = false
 e.state.SentAttachmentID = ""
 e.muteBusy = nil
 e.state.MarkReadEnabled = true
 e.cancelReadView()
 e.readCursors = nil
 e.state.ReadNote = ""
 e.historyStore = nil
 e.mediaStore = nil
 e.notificationChats = nil
 e.notificationInitial = nil
 e.notificationQueue = nil
 e.notificationScanActive = false
 e.notificationSeen = nil
 e.notificationOrder = nil
 e.historyCached = nil
 e.historyEnd = 0
 e.state.HistoryOlder = false
 e.state.HistoryNewer = false`,
    );
    change(
      'case "select":',
      'case "history-older":\n e.pageHistory(-1)\n case "history-newer":\n e.pageHistory(1)\n case "select":',
    );
    change(
      'case "refresh":',
      `case "media-cache-toggle", "media-cache-clear":
 e.mediaControl(c.Action)
 case "notification-test":
  e.testNotification()
 case "read-visible":
  e.visibleRead(c)
 case "mark-read-toggle":
  e.toggleMarkRead()
 case "chat-mute-toggle":
  e.toggleChatMute(c)
 case "auto-images":
  if e.state.Mode == "live" && e.state.Account.ID != "" {
    e.state.AutoImages = c.Enabled
    if !e.mediaStore.setAutoImages(c.Enabled) { e.state.SendNote = "Image preview preference could not be saved" }
  }
 case "refresh":`,
    );
    change(
      'e.state.Messages = []Message{}\n\te.state.HistoryStatus = "loading"',
      `e.state.Messages = []Message{}
 e.historyCached = nil
 if e.historyStore != nil {
   e.historyCached = e.historyStore.load(e.state.Account.ID, id)
    e.historyEnd = len(e.historyCached)
    e.showHistoryPage()
 }
 e.state.HistoryStatus = "loading"`,
    );
    change(
      'generation, epoch := e.historyGeneration, e.epoch',
      `generation, epoch := e.historyGeneration, e.epoch
 cached := append([]Message(nil), e.historyCached...)
 known := map[string]bool{}
 for _, m := range e.state.Messages { known[m.ID] = true }`,
    );
    change(
      'merged := map[string]Message{}',
      `e.applyReadReceipts(id, rows)
    concurrent := []Message{}
    for _, m := range e.state.Messages { if !known[m.ID] { concurrent = append(concurrent, m) } }
    e.historyCached = reconcileHistory(cached, rows, concurrent)
    e.purgeRemovedPhotos(id, cached, e.historyCached)
    e.cacheHistory(id, e.historyCached)
    e.historyEnd = len(e.historyCached)
    e.showHistoryPage()
    merged := map[string]Message{}`,
    );
    change(
      `merged := map[string]Message{}
\t\t\tfor _, m := range rows {
\t\t\t\tmerged[m.ID] = m
\t\t\t}
\t\t\tfor _, m := range e.state.Messages {
\t\t\t\tmerged[m.ID] = m
\t\t\t}
\t\t\te.state.Messages = []Message{}
\t\t\tfor _, m := range merged {
\t\t\t\te.state.Messages = append(e.state.Messages, m)
\t\t\t}
\t\t\tslices.SortFunc(e.state.Messages, func(a, b Message) int {
\t\t\t\tif a.Timestamp < b.Timestamp {
\t\t\t\t\treturn -1
\t\t\t\t}
\t\t\t\tif a.Timestamp > b.Timestamp {
\t\t\t\t\treturn 1
\t\t\t\t}
\t\t\t\treturn strings.Compare(a.ID, b.ID)
\t\t\t})
\t\t\tif len(e.state.Messages) > 100 {
\t\t\t\te.state.Messages = e.state.Messages[len(e.state.Messages)-100:]
\t\t\t}`,
      '',
    );
    change(
      'type Engine struct {',
      `type Engine struct {
 stickerPreview *Sticker
 stickerLoading map[string]uint64`,
    );
    change(
      'case "sticker-open", "sticker-page",',
      'case "sticker-preview":\n e.previewSticker(c)\n case "sticker-open", "sticker-page",',
    );
    change('c.Text == "ja" || c.Text == "en"', 'c.Text == "ja" || c.Text == "en" || c.Text == "zh-TW"');
    change('c.Locale == "ja" || c.Locale == "en"', 'c.Locale == "ja" || c.Locale == "en" || c.Locale == "zh-TW"');
    change(
      'type View struct {',
      `type View struct {
 MarkReadEnabled bool \`json:"markReadEnabled"\`
 ReadNote string \`json:"readNote"\`
  AutoImages bool \`json:"autoImages"\`
  MediaCacheEnabled bool \`json:"mediaCacheEnabled"\`
  MediaCacheBytes int64 \`json:"mediaCacheBytes"\`
  HistoryOlder bool \`json:"historyOlder"\`
  HistoryNewer bool \`json:"historyNewer"\`
  DownloadReceived int64 \`json:"downloadReceived"\`
 DownloadTotal int64 \`json:"downloadTotal"\`
 DownloadMessageID string \`json:"downloadMessageId"\``,
    );
    change('type View struct {', 'type View struct {\n PreviewMessageID string `json:"previewMessageId"`');
    change('v.Preview = ""', 'v.Preview = ""\n v.PreviewMessageID = ""');
    change('type Message struct {', 'type Message struct {\n Read bool `json:"read"`');
    change('Notifications: true}', 'Notifications: true, AutoImages: true, MarkReadEnabled: true}');
    change('type Engine struct {', 'type Engine struct {\n readUntil map[string]string');
    change('Kind, Revision, ChatID string', 'Kind, Revision, ChatID string\n ReaderID, MessageID string');
    change('func (e *Engine) resetIdentity() {', 'func (e *Engine) resetIdentity() {\n e.readUntil = nil');
  }
  if (file === 'internal/gui/images.go') {
    change(
      `if cached := e.avatarData[path]; cached != "" {
\t\t\te.addAvatar(id, cached)
\t\t\tcontinue
\t\t}`,
      `if cached := e.avatarData[path]; cached != "" {
      e.addAvatar(id, cached)
      continue
    }
    if cached := e.mediaStore.load("avatar", path); cached != "" {
      if e.cacheAvatar(path, cached) { e.addAvatar(id, cached) } else { e.avatarFailed[path] = true }
      continue
    }`,
    );
    change(
      `if !isDataImage(data) || !e.cacheAvatar(path, data) {
\t\t\t\te.avatarFailed[path] = true
\t\t\t}`,
      `if !isDataImage(data) || !e.cacheAvatar(path, data) {
        e.avatarFailed[path] = true
      } else {
        e.mediaStore.saveVersion("avatar", path, data, cacheVersion)
        e.state.MediaCacheBytes = e.mediaStore.usage()
      }`,
    );
    change('epoch := e.epoch', 'epoch := e.epoch\n cacheVersion := e.mediaStore.writeVersion()');
    change(
      'if e.stickerAttempted[key] {',
      `if cached := e.mediaStore.load("sticker", mediaStickerKey(s)); cached != "" {
     e.cacheSticker(key, cached)
     continue
   }
   if e.stickerAttempted[key] {`,
    );
    change(
      'stickers := []Sticker{}',
      `stickers := []Sticker{}
 e.clearStaleStickerLoads()
 if s := e.activeStickerPreview(); s != nil { stickers = append(stickers, *s) }`,
    );
    change(
      'e.stickerAttempted[key] = true',
      `e.stickerAttempted[key] = true
 if e.stickerLoading == nil { e.stickerLoading = map[string]uint64{} }
 e.stickerLoading[key] = e.stickerGeneration + 1`,
    );
    change(
      'generation := e.stickerGeneration',
      'generation := e.stickerGeneration\n cacheVersion := e.mediaStore.writeVersion()',
    );
    change('e.stickerActive--', 'e.stickerActive--\n delete(e.stickerLoading, key)');
    change(
      `total := 0
				for _, old := range e.stickerData {
					total += len(old)
				}
				if total+len(data) <= 1<<20 {
					e.stickerData[key] = data
					e.addSticker(key, data)
				}`,
      `e.cacheSticker(key, data)
  e.mediaStore.saveVersion("sticker", mediaStickerKey(s), data, cacheVersion)
 e.state.MediaCacheBytes = e.mediaStore.usage()`,
    );
    change(
      `func (e *Engine) addSticker(key, data string) {
	if e.state.StickerImages[key] == data {
		return
	}
	bytes := 2
	for k, v := range e.state.StickerImages {
		if k != key {
			bytes += imageCost(k, v)
		}
	}
	if bytes+imageCost(key, data) > 1<<20 {
		return
	}
	e.state.StickerImages[key] = data
}`,
      'func (e *Engine) addSticker(key, data string) { e.cacheSticker(key, data) }',
    );
  }
  if (file === 'internal/gui/photos.go') {
    change(
      'if !e.current(c) {\n\t\treturn\n\t}',
      `if !e.current(c) {
    return
  }
  if c.Action == "photos-visible" && !e.state.AutoImages {
    return
  }`,
    );
    change(
      'e.photoQueue = nil\n\t\te.photoVisible = map[string]bool{}',
      `e.photoQueue = nil
    previousVisible := e.photoVisible
    e.photoVisible = map[string]bool{}`,
    );
    change(
      'e.photoVisible[id] = true\n\t\t\tif e.state.PhotoThumbnails[id].Status == "" {',
      `e.photoVisible[id] = true
      // Retry only when an image re-enters the viewport. Do not retry a
      // permanent failure on every unrelated state update.
      if !previousVisible[id] && e.state.PhotoThumbnails[id].Status == "error" {
        e.setPhoto(id, PhotoThumbnail{})
      }
      if e.state.PhotoThumbnails[id].Status == "" {`,
    );
    change(
      'e.spawn(func() {\n\t\t\tdefer cancel()',
      `cache := e.mediaStore
    cacheVersion := cache.writeVersion()
    photoKey := mediaPhotoKey(c.ID, id)
    e.spawn(func() {
      defer cancel()`,
    );
    change(
      `var data []byte
\t\t\tvar err error
\t\t\tif mode == "demo" {
\t\t\t\tdata = demoPhotoBytes()
\t\t\t} else if e.ops.Download != nil {
\t\t\t\tdata, err = e.ops.Download(ctx, c.ID, id)
\t\t\t} else {
\t\t\t\terr = errors.New("unavailable")
\t\t\t}
\t\t\tthumb := ""
\t\t\tif err == nil && ctx.Err() == nil {
\t\t\t\tthumb = photoThumbnail(data)
\t\t\t}`,
      `thumb := ""
      if mode != "demo" { thumb = cache.load("thumbnail", photoKey) }
      fromCache := thumb != ""
      var data []byte
      var err error
      if thumb == "" {
        if mode == "demo" {
          data = demoPhotoBytes()
        } else if e.ops.Download != nil {
          data, err = e.ops.Download(ctx, c.ID, id)
        } else {
          err = errors.New("unavailable")
        }
        if err == nil && ctx.Err() == nil { thumb = photoThumbnail(data) }
      }`,
    );
    change(
      `e.setPhoto(id, PhotoThumbnail{Status: "error"})
\t\t\t\t}
\t\t\t} else if`,
      `e.setPhoto(id, PhotoThumbnail{Status: "error"})
        } else if mode != "demo" && !fromCache {
          cache.saveVersion("thumbnail", photoKey, thumb, cacheVersion)
          e.state.MediaCacheBytes = cache.usage()
        }
      } else if`,
    );
  }
  if (file === 'internal/gui/stickers.go') {
    change('epoch := e.epoch', 'epoch := e.epoch\n cacheVersion := e.mediaStore.writeVersion()');
    change(
      'e.products = nil\n\tepoch := e.epoch',
      `e.products = nil
  if e.state.Mode == "live" {
    if cached := e.mediaStore.loadCatalog(); len(cached) > 0 {
      e.products = cached
      for _, p := range cached {
        v.Products = append(v.Products, StickerProduct{
          ID: p.ID, Name: p.Name, Count: p.Count, Supported: p.Supported, ResourceType: p.ResourceType,
          Poster: &Sticker{ID: p.Ranges[0].Start, PackageID: p.ID, Version: p.Version, Hash: p.Hash},
        })
      }
      e.stickerPage(cached[0].ID, 0)
      e.syncStickerImages()
    }
  }
  epoch := e.epoch`,
    );
    change(
      'e.products = products\n\t\tfor _, p := range products {',
      `e.invalidateChangedStickers(products)
    e.products = products
    v.Products = []StickerProduct{}
     if mode != "demo" { e.mediaStore.saveCatalogVersion(products, cacheVersion) }
    for _, p := range products {`,
    );
    change(
      'Poster: &Sticker{ID: p.Ranges[0].Start, Hash: p.Hash}',
      'Poster: &Sticker{ID: p.Ranges[0].Start, PackageID: p.ID, Version: p.Version, Hash: p.Hash}',
    );
  }
  if (file === 'internal/gui/locale.go') {
    change(
      'func appText(locale, value string) string {',
      'func appText(locale, value string) string {\n if locale == "zh-TW" { return chineseText(appText("en", value)) }',
    );
    change(
      'func (e *Engine) localizedView() View {',
      'func (e *Engine) localizedView() View {\n if e.locale == "zh-TW" { return e.chineseView() }',
    );
  }
  if (file === 'internal/gui/direct.go') {
    change(
      'messaging.Attachment{Name: file.Name, Data: file.Data}',
      'messaging.Attachment{Name: file.Name, Data: file.Data, Image: file.Image}',
    );
    change('names := map[string]string{}', 'muted := map[string]bool{}\n names := map[string]string{}');
    change('} else if names[c.ID] == "" {', '} else {');
    change(
      'names[id] = label(w.Contact.EffectiveDisplayName(), 160)',
      'muted[id] = number(w.Contact.Settings)&1 != 0\n names[id] = label(w.Contact.EffectiveDisplayName(), 160)',
    );
    change(
      'names[group.ChatMid] = label(group.ChatName, 160)',
      'muted[group.ChatMid] = group.NotificationDisabled\n names[group.ChatMid] = label(group.ChatName, 160)',
    );
    change('c := &result.Chats[i]', 'c := &result.Chats[i]\n c.Muted, c.MuteKnown = muted[c.ID]');
    change('sender = label(raw.From, 160)', 'sender = label(raw.From, 160)\n fallback = true');
    change('type watchSink struct {', 'type watchSink struct {\n direct *Direct');
    change('sink := &watchSink{', 'sink := &watchSink{direct: d,');
    change(
      'm := projectMessage(*event.Message, w.account, w.names, w.nameFallbacks)',
      `m := projectMessage(*event.Message, w.account, w.names, w.nameFallbacks)
 if w.direct != nil { m = w.direct.projectLiveMessage(*event.Message) }`,
    );
    change(
      'out[id] = ProfileInfo{Name: label(w.Contact.EffectiveDisplayName(), 160), Path: w.Contact.PicturePath}',
      `out[id] = ProfileInfo{Name: label(w.Contact.EffectiveDisplayName(), 160), Path: w.Contact.PicturePath}
 if out[id].Name == id { p := out[id]; p.Name = ""; out[id] = p }`,
    );
    change(
      'if out[id].Name == id { p := out[id]; p.Name = ""; out[id] = p }\n\t}\n\treturn out, nil',
      `if out[id].Name == id { p := out[id]; p.Name = ""; out[id] = p }
 }
 if err := d.fillPublicProfiles(manager, ctx, ids, out); errors.Is(err, ErrUnauthenticated) { return nil, err }
 d.rememberProfiles(out)
 return out, nil`,
    );
    change(
      'if err = manager.Do(func(api session.API) (err error) { response, err = api.GetContactsV2(ids); return }); ' +
        'err != nil || response == nil {',
      `if err = manager.Do(func(api session.API) (err error) { response, err = api.GetContactsV2(ids); return });
 err != nil || response == nil {
 if !errors.Is(classify(err), ErrUnauthenticated) {
   fallback := map[string]ProfileInfo{}
   publicErr := d.fillPublicProfiles(manager, ctx, ids, fallback)
   if errors.Is(publicErr, ErrUnauthenticated) { return nil, publicErr }
   if publicErr == nil && len(fallback) > 0 { d.rememberProfiles(fallback); return fallback, nil }
 }`,
    );
    change(
      'd.account = result.Account',
      `if d.account.ID == result.Account.ID {
 for id, name := range d.names {
 if names[id] == "" { names[id] = name; nameFallbacks[id] = d.nameFallbacks[id] }
 }
 }
 d.account = result.Account`,
    );
    change(
      'updated := int64(0)',
      `lastID := ""
 updated := int64(0)`,
    );
    change(
      'updated = number(box.LastDeliveredMessageID.DeliveredTime)',
      `updated = number(box.LastDeliveredMessageID.DeliveredTime)
 lastID = box.LastDeliveredMessageID.MessageID`,
    );
    change(
      'updated = max(updated, number(m.CreatedTime))',
      `updated = max(updated, number(m.CreatedTime))
 if newerNotificationID(m.ID, lastID) { lastID = m.ID }`,
    );
    change('Chat{ID: box.ID,', 'Chat{NotificationLastID: lastID, ID: box.ID,');
    change('NotifyMessage: notifyMessage,', 'NotifyDiagnostic: desktopNotification,');
    change(
      'return Operations{Members:',
      'return Operations{SetMuted: d.setMuted, MarkRead: d.markRead, ' +
        'CacheDir: historyCacheDir(), MediaDir: mediaCacheDir(), Members:',
    );
    change('ChatID: event.ChatID}', 'ChatID: event.ChatID, ReaderID: event.ReaderID, MessageID: event.MessageID}');
  }
  if (file === 'internal/gui/receive.go') {
    change('if !m.Own {', 'if !m.Own && newerNotificationID(m.ID, e.state.Chats[i].NotificationLastID) {');
    change('e.notice(m, event.ChatID)', 'e.promoteActivity(event.ChatID, m)\n e.notice(m, event.ChatID)');
    change('when := time.UnixMilli(m.Timestamp)', 'when := now');
    change(
      'if !e.state.Notifications || m.Own || when.Before(e.startedAt.Add(-2*time.Second)) || ' +
        'when.Before(now.Add(-30*time.Second)) || when.After(now.Add(5*time.Second)) || ' +
        'e.focusID == chat && e.focusSession == e.state.Session && e.focusSelection == e.state.Selection {' +
        '\n\t\treturn\n\t}',
      `if !e.state.Notifications {
    return
  }
  if m.Own || e.chatMuted(chat) {
    return
  }
  if e.focusID == chat && e.focusSession == e.state.Session && e.focusSelection == e.state.Selection {
    return
   }`,
    );
    change(
      'for id, pending := range e.noticePending {',
      'for id, pending := range e.noticePending {\n if e.chatMuted(id) { continue }',
    );
    change('var latest pendingNotice', 'var latest pendingNotice\n latestChat := ""');
    change('latest = pending', 'latest = pending\n latestChat = id');
    change(
      'delivered := notify(ctx)',
      `e.mu.Lock()
 blocked := e.disposed || e.epoch != epoch || e.chatMuted(latestChat)
 e.mu.Unlock()
 if blocked { return }
 delivered := notify(ctx)`,
    );
    change('notify := e.ops.Notify', 'diagnostic := ""\n notify := e.ops.Notify');
    change(
      'if notify == nil {',
      `if e.ops.NotifyDiagnostic != nil {
    title, body := messageNotification(locale, latest)
    notify = func(ctx context.Context) bool {
      diagnostic = e.ops.NotifyDiagnostic(ctx, title, body)
      return diagnostic == ""
    }
  }
  if notify == nil {`,
    );
    change(
      `if !delivered {
\t\t\t\te.state.NotificationNote = "通知を表示できません。notify-send の導入を確認してください"
\t\t\t\te.publish()
\t\t\t}`,
      `note := diagnostic
      if !delivered && note == "" { note = "通知を表示できません。notify-send の導入を確認してください" }
      if e.state.NotificationNote != note {
        e.state.NotificationNote = note
        e.publish()
      }`,
    );
    change(
      'e.notice(m, event.ChatID)',
      `if e.historyStore != nil {
    rows := e.historyStore.load(e.state.Account.ID, event.ChatID)
    rows = upsertHistory(rows, m)
    e.cacheHistory(event.ChatID, rows)
    if e.state.SelectedID == event.ChatID {
      latest := e.historyEnd == len(e.historyCached)
      e.historyCached = rows
      if latest { e.historyEnd = len(rows); e.showHistoryPage() }
    }
  }
   e.observeNotification(m, event.ChatID)`,
    );
    change(
      'if event.Kind == "resync_required"',
      `if event.Kind == "read" { e.receiveRead(event); return }
 if event.Kind == "media" { e.receiveMedia(event); return }
 if event.Kind == "resync_required"`,
    );
    change(
      'm := *event.Message',
      'm := *event.Message\n rows := []Message{m}\n e.applyReadReceipts(event.ChatID, rows)\n m = rows[0]',
    );
  }
  if (file === 'internal/gui/features.go') {
    change(
      'file, err := snapshotFile(c.URL)',
      `file, err := snapshotFile(c.URL)
 if err == nil && c.Mode == "image" {
   err = validatePhotoAttachment(file.Data)
   if err == nil { file.Image = true }
 }`,
    );
    change(
      'e.state.SendNote = "添付は20 MiB以下の通常ファイルを選んでください。リンクや特殊ファイルは使えません"',
      `e.state.SendNote = "添付は20 MiB以下の通常ファイルを選んでください。リンクや特殊ファイルは使えません"
 if c.Mode == "image" { e.state.SendNote = "Choose valid PNG/JPEG photos up to 20 MiB and 32 megapixels" }`,
    );
    change(
      'if c.Action == "unsend" {\n\t\t\te.state.Messages = slices.DeleteFunc',
      `if c.Action == "unsend" {
      if e.state.Mode == "live" {
        key := mediaPhotoKey(c.ID, c.MessageID)
        e.mediaStore.remove("thumbnail", key)
        e.mediaStore.remove("preview", key)
      }
      e.state.Messages = slices.DeleteFunc`,
    );
    change(
      `generation := e.fileGeneration + 1
\te.fileGeneration = generation
\tepoch := e.epoch
\tmode := e.state.Mode
\te.publish()`,
      `generation := e.fileGeneration + 1
  e.fileGeneration = generation
  epoch := e.epoch
  mode := e.state.Mode
   cache := e.mediaStore
   cacheVersion := cache.writeVersion()
   photoKey := mediaPhotoKey(c.ID, c.MessageID)
  e.publish()`,
    );
    change(
      `} else {
\t\t\tdata, err = e.ops.Download(ctx, c.ID, c.MessageID)
\t\t}`,
      `} else if c.Action == "preview" {
      cachedPreview = cache.load("preview", photoKey)
      if cachedPreview == "" { data, err = e.ops.Download(ctx, c.ID, c.MessageID) }
    } else {
      data, err = e.ops.Download(ctx, c.ID, c.MessageID)
    }`,
    );
    change(
      'var data []byte\n\t\tvar err error\n\t\tif mode == "demo" {',
      `var data []byte
    var err error
    cachedPreview := ""
    if mode == "demo" {`,
    );
    change(
      'preview := sanitizedImage(data, 2<<20, 4096)',
      `preview := cachedPreview
        if preview == "" { preview = sanitizedImage(data, 2<<20, 4096) }`,
    );
    change(
      'e.state.Preview = preview',
      `e.state.Preview = preview
            if mode != "demo" && cachedPreview == "" {
               cache.saveVersion("preview", photoKey, preview, cacheVersion)
              e.state.MediaCacheBytes = cache.usage()
            }`,
    );
    change(
      'if e.state.Mode == "live" && e.current(c) {',
      `if e.state.Mode == "live" && c.Action == "unsend" && e.historyStore != nil {
    e.cacheHistory(c.ID, removeHistory(e.historyStore.load(e.state.Account.ID, c.ID), c.MessageID))
  }
  if e.state.Mode == "live" && e.current(c) {`,
    );
    change(
      'data, err = e.ops.Download(ctx, c.ID, c.MessageID)',
      'data, err = e.ops.Download(e.downloadContext(ctx, c, epoch, generation), c.ID, c.MessageID)',
    );
    change(
      'e.state.FileStatus = "pending"',
      `e.state.FileStatus = "pending"
 e.state.DownloadReceived = 0
 e.state.DownloadTotal = 0
 e.state.DownloadMessageID = c.MessageID`,
    );
    change('e.state.Preview = preview', 'e.state.Preview = preview\n e.state.PreviewMessageID = c.MessageID');
    change('e.state.Preview = ""', 'e.state.Preview = ""\n e.state.PreviewMessageID = ""');
  }
  if (file === 'pkg/line/client.go') {
    change(
      '"type": obsType,\n\t}',
      `"type": obsType,
 }
 if obsType == "image" { obsParams["cat"] = "original" }`,
    );
    change(
      'body, readErr := io.ReadAll(reader)',
      'body, readErr := io.ReadAll(TrackDownload(ctx, reader, resp.ContentLength))',
    );
  }
  if (file === 'internal/gui/receipts.go') {
    change(
      'if e.state.Mode == "demo" {',
      `if e.state.Mode == "live" && e.historyStore != nil {
    rows := upsertHistory(e.historyStore.load(e.state.Account.ID, chat), item)
    e.cacheHistory(chat, rows)
    if e.state.SelectedID == chat {
      latest := e.historyEnd == len(e.historyCached)
      e.historyCached = rows
      if latest { e.historyEnd = len(rows); e.showHistoryPage() }
    }
  }
  if e.state.Mode == "demo" {`,
    );
    change(
      'func (e *Engine) sentMessage(chat string, item Message) {',
      `func (e *Engine) sentMessage(chat string, item Message) {
      rows := []Message{item}
      e.applyReadReceipts(chat, rows)
      item = rows[0]`,
    );
  }
  if (file === 'internal/gui/lifecycle.go') {
    change(
      'snapshot.Chats[i].Preview = old.Preview',
      `if !snapshot.Chats[i].MuteKnown {
 snapshot.Chats[i].Muted, snapshot.Chats[i].MuteKnown = old.Muted, old.MuteKnown
 }
 snapshot.Chats[i].Preview = old.Preview`,
    );
    change(
      'snapshot.Chats[i].Preview = old.Preview',
      `if newerNotificationID(old.NotificationLastID, snapshot.Chats[i].NotificationLastID) {
 snapshot.Chats[i].NotificationLastID = old.NotificationLastID
 }
 snapshot.Chats[i].Preview = old.Preview`,
    );
    change(
      'e.state.Chats = append(append([]Chat{}, snapshot.Chats...), local...)',
      `previousChats := append([]Chat{}, e.state.Chats...)
 e.state.Chats = append(append([]Chat{}, snapshot.Chats...), local...)`,
    );
    change(
      'e.state.Contacts = snapshot.Contacts',
      `e.reconcileActivityOrder(previousChats)
 e.applyReadBadges()
 e.state.Contacts = snapshot.Contacts`,
    );
    change(
      'e.startWatch()\n\t\te.syncAvatars(!resync)',
      'e.refreshNotifications(snapshot.Chats)\n e.startWatch()\n\t\te.syncAvatars(!resync)',
    );
    change(
      'e.state.Account = snapshot.Account',
      `e.state.Account = snapshot.Account
    if e.historyStore == nil { e.historyStore = openHistoryCache(e.ops.CacheDir, snapshot.Account.ID) }
    if e.mediaStore == nil { e.mediaStore = openMediaCache(e.ops.MediaDir, snapshot.Account.ID) }
    e.state.MediaCacheEnabled = e.mediaStore.active()
     e.state.AutoImages = e.mediaStore.autoImages()
     e.state.MarkReadEnabled = e.mediaStore.preferenceEnabled("mark-read-off")
    e.state.MediaCacheBytes = e.mediaStore.usage()`,
    );
  }
  if (file === 'pkg/line/structs.go') {
    change('type Contact struct {', 'type Contact struct {\n Settings json.Number `json:"settings"`');
  }
  if (file === 'internal/gui/profiles.go') {
    change('selection := e.state.Selection', '');
    change('if err != nil || e.state.Selection != selection {', 'if err != nil {');
    change(
      'e.picturePaths[m.SenderID] == "" && !e.profileAttempted[m.SenderID]',
      `(e.picturePaths[m.SenderID] == "" || m.SenderUnavailable ||
 m.Sender == m.SenderID || m.Sender == "") && !e.profileAttempted[m.SenderID]`,
    );
    change('e.syncAvatars(false)', 'e.refreshResolvedNames(profiles)\n e.syncAvatars(false)');
  }
  if (file === 'internal/messaging/files.go') {
    change('type Attachment struct {', 'type Attachment struct {\n Image bool');
    change(
      'func (c *Client) uploadFile(file *Attachment, metadata map[string]string) ([]byte, error) {',
      `func (c *Client) uploadFile(file *Attachment, metadata map[string]string) ([]byte, error) {
 if file.Image { return c.uploadPhoto(file, metadata) }`,
    );
  }
  if (file === 'internal/messaging/client.go') {
    change(
      'kind := toType(chat)',
      `var photo *photoUpload
 if file != nil && file.Image {
   var err error
   photo, err = preparePhoto(file.Data)
   if err != nil { return nil, err }
 }
 kind := toType(chat)`,
    );
    change(
      'var chunks []string',
      `if photo != nil { contentType = 1; photo.metadata(metadata, len(file.Data)) }
 var chunks []string`,
    );
    change('own, int(peer), 14, payload)', 'own, int(peer), contentType, payload)');
    change(
      'c.crypto.EncryptGroupMessageRaw(chat, c.state.MID, 14, payload)',
      'c.crypto.EncryptGroupMessageRaw(chat, c.state.MID, contentType, payload)',
    );
    change(
      'return api.UploadOBSPlain(file.Data, sent.ID, "file")',
      `if photo != nil {
   return photoFailure("upload original (plain)", api.UploadOBSPlain(file.Data, sent.ID, "image"))
 }
 return api.UploadOBSPlain(file.Data, sent.ID, "file")`,
    );
    change(
      'if file != nil {\n\t\t\treturn nil, errors.New("could not prepare encrypted attachment;',
      `if file != nil {
       if file.Image { return nil, err }
       return nil, errors.New("could not prepare encrypted attachment;`,
    );
    change(
      'return nil, fmt.Errorf("send did not return success;',
      `if photo != nil { return nil, photoFailure("send acknowledgement", err) }
 return nil, fmt.Errorf("send did not return success;`,
    );
    change(
      'return nil, errors.New("send returned no message ID;',
      `if photo != nil { return nil, photoFailure("send acknowledgement", errPhotoMessageID) }
 return nil, errors.New("send returned no message ID;`,
    );
  }
  return source;
}

module.exports = { patchFile };
