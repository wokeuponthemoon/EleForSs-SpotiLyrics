export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const rawQuery = (req.query.q || '').trim();
  if (!rawQuery) {
    return res.status(400).json({ error: 'Empty query' });
  }

  const SPOTIFY_BASE = ['https:/', 'open.spotify.com'].join('/');
  const LRCLIB_GET = ['https:/', 'lrclib.net', 'api', 'get'].join('/');
  const LRCLIB_SEARCH = ['https:/', 'lrclib.net', 'api', 'search'].join('/');

  try {
    const spotifyMatch = rawQuery.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([a-zA-Z0-9]+)/);
    if (!spotifyMatch) {
      return res.status(400).json({ error: 'Only Spotify track links are supported' });
    }

    const cleanSpotifyUrl = SPOTIFY_BASE + '/track/' + spotifyMatch[1];
    let coverUrl = null;
    let trackName = '';
    let artistName = '';
    let duration = 160;

    // 1. Получаем данные через Spotify oEmbed (title: "Artist - Track" или "Track")
    try {
      const oembedRes = await fetch(
        SPOTIFY_BASE + '/oembed?url=' + encodeURIComponent(cleanSpotifyUrl)
      );
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        if (oembed.thumbnail_url) coverUrl = oembed.thumbnail_url;
        if (oembed.title) {
          const dashIdx = oembed.title.indexOf(' - ');
          if (dashIdx !== -1) {
            artistName = oembed.title.slice(0, dashIdx).trim();
            trackName = oembed.title.slice(dashIdx + 3).trim();
          } else {
            trackName = oembed.title.trim();
          }
        }
      }
    } catch (_) {}

    // 2. Уточняем точное имя артиста, обложку и длительность через OpenGraph мета-теги самой страницы Spotify
    try {
      const pageRes = await fetch(cleanSpotifyUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)'
        }
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
        const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
        const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
        const durMatch = html.match(/<meta name="music:duration" content="(\d+)"/i);

        if (titleMatch && titleMatch[1]) {
          const ogTitle = titleMatch[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim();
          if (ogTitle && !ogTitle.toLowerCase().includes('spotify')) {
            trackName = ogTitle;
          }
        }
        if (descMatch && descMatch[1]) {
          const desc = descMatch[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
          const parts = desc.split('·').map((s) => s.trim());
          if (parts.length >= 2) {
            const parsedArtist = parts[0].replace(/^Listen to .* on Spotify\.\s*/i, '').trim();
            if (parsedArtist) artistName = parsedArtist;
          }
        }
        if (!coverUrl && imgMatch && imgMatch[1]) {
          coverUrl = imgMatch[1];
        }
        if (durMatch && durMatch[1]) {
          duration = parseInt(durMatch[1], 10) || duration;
        }
      }
    } catch (_) {}

    // Если в названии трека всё равно остался префикс "Artist - ", убираем его
    if (artistName && trackName.toLowerCase().startsWith(artistName.toLowerCase() + ' - ')) {
      trackName = trackName.slice(artistName.length + 3).trim();
    }

    // 3. Строгий поиск текста в LRCLIB только по точному совпадению "Артист + Трек"
    let lines = [];
    const parseLrc = (best) => {
      const dur = best.duration || duration;
      const out = [];
      if (best.syncedLyrics) {
        const timeRegex = /^\[(\d{1,2}):(\d{2})(?:\.\d+)?\]\s*(.*)$/;
        for (const raw of best.syncedLyrics.split('\n')) {
          const m = raw.trim().match(timeRegex);
          if (m && m[3].trim()) {
            const mins = parseInt(m[1], 10);
            const secs = parseInt(m[2], 10);
            const pct = Math.min(95, Math.max(5, Math.round(((mins * 60 + secs) / dur) * 100)));
            out.push({
              text: m[3].trim(),
              time: mins + ':' + secs.toString().padStart(2, '0'),
              progress: pct
            });
          }
        }
      } else if (best.plainLyrics) {
        const plain = best.plainLyrics.split('\n').map((s) => s.trim()).filter(Boolean);
        plain.forEach((txt, idx) => {
          out.push({
            text: txt,
            time: '0:30',
            progress: Math.min(92, Math.max(8, Math.round(((idx + 1) / (plain.length + 1)) * 100)))
          });
        });
      }
      return out;
    };

    const cleanTrack = trackName.replace(/\s*\(feat\..*?\)/gi, '').replace(/\s*\[.*?\]/g, '').trim();
    const primaryArtist = artistName.split(/,|&|feat\./i)[0].trim();

    if (primaryArtist && cleanTrack) {
      try {
        const exactRes = await fetch(
          LRCLIB_GET + '?artist_name=' + encodeURIComponent(primaryArtist) + '&track_name=' + encodeURIComponent(cleanTrack),
          { headers: { 'User-Agent': 'EleForSs-SpotiLyrics/1.0' } }
        );
        if (exactRes.ok) {
          const exactItem = await exactRes.json();
          if (exactItem && (exactItem.syncedLyrics || exactItem.plainLyrics)) {
            duration = exactItem.duration || duration;
            lines = parseLrc(exactItem);
          }
        }
      } catch (_) {}
    }

    if (lines.length === 0 && cleanTrack) {
      try {
        const q = primaryArtist ? primaryArtist + ' ' + cleanTrack : cleanTrack;
        const lrcRes = await fetch(
          LRCLIB_SEARCH + '?q=' + encodeURIComponent(q),
          { headers: { 'User-Agent': 'EleForSs-SpotiLyrics/1.0' } }
        );
        if (lrcRes.ok) {
          const lrcList = await lrcRes.json();
          const items = Array.isArray(lrcList) ? lrcList : [];
          const artistLow = primaryArtist.toLowerCase();
          const trackLow = cleanTrack.toLowerCase();

          const strictMatch = items.find((t) => {
            if (!t.syncedLyrics && !t.plainLyrics) return false;
            const a = (t.artistName || '').toLowerCase();
            const n = (t.trackName || '').toLowerCase();
            const artistOk = !artistLow || a.includes(artistLow) || artistLow.includes(a);
            const trackOk = n.includes(trackLow) || trackLow.includes(n);
            return artistOk && trackOk;
          });

          if (strictMatch) {
            duration = strictMatch.duration || duration;
            lines = parseLrc(strictMatch);
          }
        }
      } catch (_) {}
    }

    return res.status(200).json({
      trackName: trackName || 'Untitled',
      artistName: artistName || 'Artist',
      duration,
      coverUrl,
      themeColor: '#18181b',
      lines
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Spotify fetch failed' });
  }
}
