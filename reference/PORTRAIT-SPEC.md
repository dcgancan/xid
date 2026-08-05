# X ID — portre spesifikasyonu (ölçüme dayalı)

Tarih: 2026-08-05. Tüm sayılar `/tmp/xid-research/` altındaki scriptlerle ölçüldü
(`measure.py`, `findportraits.py`). Vision modelinin renk/opaklık yorumlarına
güvenilmedi; her iddia piksel ölçümüyle doğrulandı veya çürütüldü.

## 0. KÖK NEDEN: referans video bir kimlik kartı değil

`reference/avstorm-holo.mp4` bir TC kimlik kartı DEĞİL. Bir telefon ekranının
kamerayla yeniden çekilmiş görüntüsü ve ekranda **Airbnb kimlik doğrulama
kartı** var. 2x büyütmede okunan metin:

    "...dreas"  /  "...rified since February 2019"
    "...st is the cornerstone of ...bnb's community, and identity
     ...rification is part of how we ...ild it."
    "...identity verification process checks a ...son's information against
     trusted third-...ty sources or a government ID."

Sayısal doğrulama — kart ortası (f_001 / f_019):

| ölçüm | referans video | gerçek TC kimlik (c095) | TC numune (c000) |
|---|---|---|---|
| sat_mean | 0.88 / 0.76 | 0.09 | 0.011 |
| chroma_mean | 173 / 140 | 12.5 | 1.7 |
| grey_frac | 0.03 | 0.814 | 0.995 |
| warm hue payı | %52 / %61 | %16 | %6 |
| violet payı | %24 / %9 | **%0** | %31 (zeminden) |

Doygunluk farkı 8-80x. Yani ilk implementasyonların tamamı
portreyi **bir kimlik belgesine değil, bir uygulama arayüzü kartına** fit etti.
Mor/amber duotone anchor'ları, "referans %0 sarı içerir", "luma 125'e eşitle"
hedefleri hep o pembe-magenta gradyandan çıkarıldı. Portrenin bir türlü doğru
görünmemesinin nedeni buydu: doğru teknik, yanlış hedef.

## 1. Gerçek kartta iki portre var

Konumlar (kart genişliği/yüksekliği yüzdesi olarak, c000 numunesinden
algoritmik tespit + gerçek kart c095 ile teyit):

| öğe | x % | y % |
|---|---|---|
| ana biyometrik fotoğraf | 7.5 – 20 | 40 – 86 |
| hayalet (ghost) portre | 82 – 93 | 52 – 78 |

Hayalet, ana fotoğrafın ~%56 yüksekliği, kabaca yarısı kadar alan.

## 2. Ana biyometrik fotoğraf = gri lazer gravür

    c000 numune : sat_mean 0.011, grey_frac 0.995, chroma_mean 1.7
    c095 gerçek : sat_mean 0.090, grey_frac 0.814, chroma_mean 12.5  (ortam ışığı)
    c031 numune : sat_mean 0.019, grey_frac 0.874

Akromatik. Mor değil, duotone değil. Eğimle renk değiştirmez — kullanıcı
teyidi: "fotoğraf eğilirken çok renk değiştirmiyor".

Uygulama: `saturate 0` + hafif kontrast eğrisi. Renk paleti YOK.

## 3. Hayalet portre SOLUK DEĞİL

En çok yanlış anlaşılan nokta. Ölçüm:

    c000: ANA luma 172.4 / std 78.7  —  HAYALET luma 167.9 / std 82.0
    c095: ANA luma 168.5 / std 45.7  —  HAYALET luma 176.7 / std 43.0

Hayalet ana fotoğrafla **aynı parlaklıkta**, hatta c095'te daha parlak, ve
c000'de daha kontrastlı. Yanındaki boş zemin 226 / std 30 — yani hayalet
zeminden 58 luma daha koyu, bir filigran gibi silik değil.

Kenar enerjisi daha yüksek (grad_x 13.76 vs 7.14): daha küçük olduğu için
detay daha sık, daha keskin bir gravür.

`grey_frac` 0.998 → hayalet de akromatik.

Yanlış yapılmaması gerekenler:
- `opacity: 0.5` ile soluklaştırmak — ölçüm bunu çürütüyor
- mor/amber palet uygulamak — c010'da hayalet %58 mor çıktı AMA yanındaki boş
  zemin de %61 mor. O baskının kendi paleti, portrenin rengi değil. Tek örneğe
  bakıp "hayalet mor" demek tam bu tuzağa düşmek olurdu.

## 4. Hayaletin üzerinden alfanümerik dizi geçer

Hem c000 numunesinde hem gerçek kart c095'te hayalet portrenin göz-burun
hizasından yatay bir karakter dizisi geçiyor. Karakterler portrenin koyu
alanlarında (saç, gözler) kayboluyor, açık alanlarında okunuyor — yani iki
katman iç içe basılmış (anti-substitution).

Kullanıcı teyidi (A): "Tam olarak numaraya dönüşmese de açı değiştikçe içeride
başka bir katman daha olduğunu hissettiriyor."

Uygulama: hayalet portrenin üzerine, `mix-blend-mode` ile karışan, eğimle
görünürlüğü artan bir karakter katmanı. Tam takas (CLI/MLI) DEĞİL — sadece
ikinci bir katmanın varlığını hissettiren bir kazanç.

## 5. Dış laminat eğimle dalgalanır

Kullanıcı teyidi (B): "dış katmandaki şeffaf parlak yapı biraz açı ile
dalgalanıyor gibi."

Mevcut `foil__veil` / `foil__bloom` / `foil__flare` katmanları bu iş için
doğru mimaride — hepsi `|tilt|`'in fonksiyonu ve fotoğrafın pikselerine
dokunmuyor. Bunlar KORUNUR, sadece portrenin altındaki duotone kaldırılır.

## Yapılacaklar

1. `#portrait-left` / `#portrait-right` duotone filtrelerini kaldır →
   tek `saturate 0` + kontrast eğrisi
2. `foil__face--right` warm plate + travelling mask'i kaldır (mor/terracotta
   polarite Airbnb kartından geliyordu)
3. Kartta ikinci portre öğesi aç: hayalet, sağ-alt x 82-93% / y 52-78%
4. Hayalet: aynı gri gravür, aynı luma bandı, daha yüksek kenar enerjisi
5. Hayaletin üzerine eğimle kazanan alfanümerik katman
6. Laminat katmanlarını (veil/bloom/grain/diffusion/flare) koru
7. `createCardImage()` canvas export'unu aynı anda güncelle — CSS ile canvas
   ayrı düşerse ekranda doğru, indirilen dosyada bozuk çıkar (daha önce iki kez
   oldu: beş bantlı posterizasyon ve mor duotone)

## Doğrulama ölçütleri

Portre tile'ı doğrudan screenshot'la (büyük kompozisyondan kırpma yapma), sonra:

- ana fotoğraf: `sat_mean < 0.03`, `grey_frac > 0.95`, her eğim açısında
- ana fotoğraf luma: eğim boyunca ±5 içinde sabit
- hayalet luma: ana fotoğrafın ±10 bandında (soluk olmadığının kanıtı)
- hayalet `grad_x` > ana fotoğrafın `grad_x`'i
- her ikisi de en az 2 farklı avatarda test (@avstorm p95 210, @dcgancan 158)
- laminat: `haze` 0→1 arasında monotonik, portrenin detayının >%90'ı korunuyor

## 2026-08-05 — Doğancan'ın yeniden tasarımı (oval hayalet)

Kullanıcının açık isteğiyle aşağıdaki ölçüm kararları kısmen devre dışı:

- Hayalet artık oval bir çerçeve içinde: `aspect-ratio 1/1.15`, `border-radius
  50%`, ince rim (`border`), `overflow: hidden`. Genişlik 11.5% → 10% düşürüldü,
  böylece dikey ayak izi değişmedi ve facts grid hâlâ temiz.
- %80 opaklık: "soluk değil" bulgusu gravürün kendisi için geçerli (band/contrast
  aynı), kapsayıcı bilinçli olarak yumuşatıldı — watermark hatasına dönüş değil.
- Oval kırpma ayrıca parlak arkaplanlı avatarlardaki dikdörtgen sorununu çözer:
  luminance-key, lum ~0.9'daki beyaz zemini alpha 1.0'a key'lediği için
  temizleyemiyordu; elips o dikdörtgeni her durumda kesiyor.
- "Hayalet ana fotoğrafla aynı crop'u örnekler" artık yanlış: iki portrenin farklı
  olması isteniyor, crop farkı bilinçli.

`createCardImage()` export'u aynı anda güncellendi: elips clip + 0.8 alpha + rim
çizimi. CSS ile canvas ayrı düşerse "ekranda doğru, dosyada bozuk" tuzağına
düşülmemesi için senkron tutuldu.
