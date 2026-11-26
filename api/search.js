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

    // Извлечение данных из oEmbed и мета-тегов Spotify с последующим строгим поиском по LRCLIB
    // Полный код обработки запроса и разбора текстов см. в

    return res.status(200).json({
      trackName: trackName || 'Untitled',
      artistName: artistName || 'Artist',
      duration,
      coverUrl,
      themeColor: '#18181b',
      lines: []
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Spotify fetch failed' });
  }
}
