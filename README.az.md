# Mirelix Homelab

[English documentation](README.md)

Mirelix-in Docker ilə öz serverində işləyən versiyası. Cloudflare hesabı, Workers və Durable Objects tələb etmir. Node.js/Socket.IO otaqları və sinxronizasiyanı idarə edir; xarici səhifələr ayrıca proksi origin-ində açılır.

Ana səhifə və otağın yuxarı hissəsindəki dil seçimindən Azərbaycan dili, English və Türkçe seçilə bilər. Dil həmin brauzerdə yadda saxlanır və otaqdan çıxmadan dəyişir. İstifadəçi adları, çat mesajları və xarici saytların məzmunu tərcümə edilmir.

## Sürətli başlatma

Docker Engine və Docker Compose olan serverdə bu qovluqda:

```sh
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Kompüterdə **http://localhost:3030**, şəbəkədə **http://SERVER_IP:3030** açın. Otaq yaradın və həmin server ünvanı ilə yaranan dəvət linkini paylaşın. `localhost` linki başqa cihazda sizin serverə açılmır.

3030 tətbiq, 3031 xarici sayt/video proksisi üçündür. Hər iki port istifadəçinin cihazından əlçatan olmalıdır. HTTP şəbəkə ünvanında çat və baxış işləyir; kamera, mikrofon və ekran göndərmək üçün brauzer HTTPS tələb edir. `localhost` istisnadır.

Portları `.env` içində dəyişə bilərsiniz:

```dotenv
APP_PORT=8080
PROXY_PORT=8081
```

Sonra `docker compose up -d` işlədin. Brauzerə qaytarılan proksi portu da avtomatik dəyişir. `.env` Docker Compose üçündür; birbaşa `npm start` onu avtomatik oxumur.

## HTTPS və domen

Hazır Caddy servisi sertifikat alır və WebSocket bağlantılarını ötürür. İki DNS adını serverin IP ünvanına yönəldin. `.env` nümunəsi:

```dotenv
APP_DOMAIN=mirelix.example.com
PROXY_DOMAIN=mirelix-proxy.example.net
PROXY_ORIGIN=https://mirelix-proxy.example.net
BIND_ADDRESS=127.0.0.1
```

```sh
docker compose --profile https up -d --build
```

80/TCP, 443/TCP və istəyə görə HTTP/3 üçün 443/UDP Caddy-yə çatmalıdır. Sertifikat üçün domenlər açıq DNS-də həll olunmalı və ACME yoxlaması serverə çatmalıdır. `example.com` və `example.net` yerinə öz domenlərinizi yazın. Yalnız lokal DNS adı varsa, mövcud reverse proxy-nizin sertifikat mexanizmini istifadə edin; cihazlar lokal sertifikata etibar etməlidir.

Tətbiq və proksi **ayrı origin** tələb edir. Eyni domen altında `/proxy` alt yolu kifayət etmir. Xarici saytlar proksidə JavaScript işlətdiyinə görə proksini ayrıca domenə vermək tövsiyə olunur. Proksi domenində tətbiq hesabları və ya başqa şəxsi servislər yerləşdirməyin.

Nginx Proxy Manager, Traefik və ya başqa reverse proxy artıq varsa, Caddy profilini açmayın: tətbiq domenini `SERVER_IP:3030`, proksi domenini `SERVER_IP:3031` ünvanına ötürün və `PROXY_ORIGIN` təyin edin. Tətbiq üçün WebSocket dəstəyini, düzgün Host və `X-Forwarded-Proto` başlıqlarını aktiv edin. Reverse proxy başqa cihazdadırsa, `BIND_ADDRESS` onun çata bildiyi server IP-si olmalıdır. HTTPS səhifəsi üçün proksi ünvanı da HTTPS olmalıdır.

## Tailscale ilə HTTPS

`http://100.x.x.x:3030` kimi ünvanlarda brauzer Web Crypto API-ni bağlayır. Bəzi pleyerlər video açarını bu API ilə açdığından `The player key did not open` xətası verir. `localhost` təhlükəsiz kontekst istisnasıdır; bir iştirakçıda işləyib digərində işləməməsi buna görə ola bilər. Həm tətbiqi, həm ayrıca proksini HTTPS ilə yayımlayın.

Standart 3030/3031 portları və hostda Tailscale, Python 3, Docker olan quraşdırmada:

```sh
./scripts/enable-tailscale-https.sh
```

Skript Tailscale üçün `sudo` şifrəsi istəyə bilər. Mövcud 443 xidmətini saxlayaraq tətbiqi `https://TAILSCALE_DNS:13030`, proksini `https://TAILSCALE_DNS:13031` altında açır. `.env` içində `PUBLIC_ORIGIN` və `PROXY_ORIGIN` yenilənir və Docker tətbiqi yenidən başladılır. Skript həm Docker-in yayımladığı portları, həm də TCP dinləyicilərini yoxlayır. 13030/13031 doludursa dayanır; başqa portlar üçün `MIRELIX_HTTPS_PORT` və `MIRELIX_PROXY_HTTPS_PORT` verilə bilər. Köhnə 8443/8444 Mirelix Serve qaydaları varsa, yalnız hədəfləri bu tətbiqə aid olduqda silinir; başqa konteynerlərə və 443 xidmətinə toxunulmur. Hər iki iştirakçı tətbiqin HTTPS ünvanını istifadə etməli və Tailscale şəbəkəsində bu portlara çıxışı olmalıdır. Uzaq HTTP otaq linkləri sonradan HTTPS ünvanına yönləndirilir. Tailscale Serve yalnız tailnet daxilində paylaşır.

`PUBLIC_ORIGIN` digər HTTPS reverse proxy quraşdırmalarında da uzaq HTTP otaq keçidlərini həmin HTTPS origin-ə yönləndirmək üçün istifadə oluna bilər.

## Səs, kamera və ekran paylaşımı

WebRTC medianı iştirakçılar arasında ötürür. Standart konfiqurasiya Google STUN istifadə edir. Eyni lokal şəbəkədə yalnız lokal ICE namizədləri ilə işləmək üçün `.env` içində `ICE_SERVERS=[]` təyin edə bilərsiniz. Çətin NAT/firewall arxasında TURN serveri lazımdır:

```dotenv
ICE_SERVERS='[{"urls":"stun:turn.example.net:3478"},{"urls":["turn:turn.example.net:3478?transport=udp","turn:turn.example.net:3478?transport=tcp"],"username":"mirelix","credential":"YOUR_TURN_PASSWORD"}]'
```

TURN servisi bu paketə daxil deyil; mövcud coturn və ya başqa TURN xidmətinin məlumatlarını istifadə edin. TURN ünvanı və relay portları iştirakçıların şəbəkəsindən əlçatan olmalıdır. ICE məlumatları brauzerə çatdırılır; həmin istifadəçi məlumatlarını bu tətbiq üçün ayırın.

Səs/video çox iştirakçı ilə işləyir: hər iştirakçının ayrıca kamera kartı və hər cütlük üçün ayrıca WebRTC bağlantısı var. Mikrofon və kamera ekran paylaşımından ayrıdır; ekran paylaşanda söhbətin səsi və kamera davam edir. Bir neçə iştirakçı eyni vaxtda ekran paylaşa bilər; Ekran bölməsindəki siyahıdan izləyəcəyiniz paylaşımı seçin. Yalnız seçilmiş ekranın tab səsi çalınır; iştirakçıların mikrofonları ayrıca eşidilir. Yerli ekran və kiçik kamera önizləməsi səssizdir ki, təkrar səs yaranmasın.

Qoşulma və yenidən qoşulma, gecikən media icazələri, mikrofon/kamera vəziyyəti və şəbəkə kəsilməsindən sonra məhdud ICE təkrarları dəstəklənir. Brauzer gələn səsi avtomatik açmağa icazə verməzsə, “Söhbətin səsini aç” düyməsi görünür. Android brauzerlərində ekran göndərmə API-si olmaya bilər; gələn paylaşımı izləmək mümkündür.

Bu quruluş kiçik qruplar üçündür. Dörd ayrı brauzer konteksti, o cümlədən qarışıq Chromium/Firefox sınaqdan keçirilib. Hər iştirakçı medianı digər iştirakçıların hər birinə ayrıca göndərdiyindən yükləmə sürəti və cihaz yükü otaq böyüdükcə artır. Əlavə SFU və ya TURN servisi standart quraşdırmaya daxil edilməyib. Mövcud Tailscale bağlantısı saxlanır, STUN ayarı dəyişdirilmir; ehtiyac yaranarsa əvvəlki `ICE_SERVERS` ayarı ilə TURN əlavə etmək mümkündür.

## Saxlanma və istifadə sərhədləri

Otaq iştirakçıları, səhifə və media sinxronu RAM-da saxlanır. Server yenidən başladıqda aktiv vəziyyət sıfırlanır; iştirakçılar yenidən qoşulur. Çat arxivi və istifadəçi hesabı verilənlər bazası yoxdur. Caddy sertifikatları Docker volume-larında saxlanır. Tətbiq əlavə disk volume-u tələb etmir.

Bu versiya şəxsi homelab istifadəsi üçündür. Daxili hesab/parol sistemi yoxdur; otaq linkinə çıxışı olan şəxs qoşula bilir. İnternetə açıq istifadəni məhdudlaşdırmaq istəyirsinizsə, giriş nəzarətini VPN və ya reverse proxy-də qurun.

Bu, tam uzaq brauzer deyil. DRM, CAPTCHA, giriş sessiyaları və bəzi xüsusi pleyerlər işləməyə bilər. Xarici saytların işləməsi onların əlçatanlığından asılıdır. Proksi lokal IP və homelab servislərinə sorğuları bloklayır; bu versiya daxili şəbəkədəki admin panellərinə ortaq brauzer kimi baxmaq üçün nəzərdə tutulmayıb. İnterfeysin şriftləri Google Fonts-dan, YouTube və xarici məzmunlar öz xidmətlərindən gəlir.

## İdarəetmə

```sh
docker compose logs -f --tail=100 mirelix
docker compose restart mirelix
docker compose down
docker compose up -d --build
```

HTTPS profilində əmrlərə `--profile https` əlavə edin. Sağlamlıq ünvanları: tətbiq və proksi üçün `/healthz`; brauzer proksi konfiqurasiyası `/api/runtime`, ICE siyahısı `/api/ice`.

## İnkişaf və yoxlama

Lokal Node.js 22.12+ ilə:

```sh
npm ci
npm run build:vendor
npm test
PROXY_PORT=3031 npm start
```

İşləyən Docker tətbiqinin portlarını, ayrıca proksi origin-ini, lokal resursları, iki iştirakçının otağa qoşulmasını, çatı və naviqasiya sinxronunu yoxlamaq üçün başqa terminalda `npm run test:homelab -- http://localhost:3030` işlədin.

Docker image-i Node.js 24 ilə yığılır, yalnız production asılılıqlarını saxlayır, `node` istifadəçisi ilə və yalnız oxunan fayl sistemi üzərində işləyir. HLS.js yığım zamanı npm paketindən lokal fayla çevrilir. Uzantısı olmayan birbaşa video/audio URL-ləri Content-Type başlığına, HLS linkləri isə playlist məzmununa əsasən avtomatik tanınır və ortaq media pleyerində açılır; media axını və Range sorğuları dəyişmədən ötürülür.

Əlavə brauzer testləri üçün:

```sh
npx playwright install chromium
npm run test:room-layout -- http://localhost:3030
npm run test:room-fullscreen -- http://localhost:3030 chromium
```

`scripts/` içindəki bəzi sinxron/media testləri ayrıca lokal fixture serveri başladır; onların real ünvanına çıxış brauzerin olduğu mühitdən mümkün olmalıdır. Homelab tətbiqinin işləməsi üçün bu testləri işə salmaq tələb olunmur.

Qrup və pleyer uyğunluğu sınaqları (tətbiq açıq olmalıdır):

```sh
npm run test:multiparty -- http://localhost:3030 mixed
npm run test:native-media -- http://localhost:3030 chromium
npm run test:native-media -- http://localhost:3030 firefox
npm run test:provider -- http://localhost:3030 chromium
npm run test:provider -- http://localhost:3030 firefox
npm run test:languages -- http://localhost:3030
```

Qrup sınağı həqiqi brauzer WebRTC bağlantıları ilə saxta kamera/mikrofon və canvas-dan ekran axını göndərir; əməliyyat sisteminin ekran seçmə pəncərəsini yoxlamır. Standart qrup sınağında xarici STUN-dan asılılığı aradan qaldırmaq üçün yalnız lokal ICE istifadə olunur; mövcud serverin STUN ayarını yoxlamaq üçün `MIRELIX_TEST_STUN=1` əlavə edin. Native media sınağı üçün `ffmpeg`, qarışıq qrup sınağı üçün həm Playwright Chromium, həm Firefox tələb olunur. Provider sınağı canlı Anikoto/MegaPlay mənbəyindən asılıdır; başqa mənbə üçün `MIRELIX_TEST_URL` verilə bilər.
