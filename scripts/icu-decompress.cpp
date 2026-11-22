#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <mutex>
#include <unordered_map>
#include <zstd.h>

extern "C" const unsigned char bun_icu_zstd_dict[];
extern "C" const unsigned bun_icu_zstd_dict_size;

extern "C" const void* bun_icu_maybe_decompress(const void* source, int32_t* length) {
  if (*length < 4) return source;
  uint32_t magic;
  std::memcpy(&magic, source, sizeof(magic));
  if (magic != ZSTD_MAGICNUMBER) return source;

  struct Item {
    const void* bytes;
    int32_t length;
  };
  static std::mutex lock;
  [[clang::no_destroy]] static std::unordered_map<const void*, Item> cache;
  static ZSTD_DCtx* const context = ZSTD_createDCtx();
  static ZSTD_DDict* const dictionary =
    ZSTD_createDDict(bun_icu_zstd_dict, bun_icu_zstd_dict_size);

  std::lock_guard<std::mutex> guard(lock);
  if (const auto hit = cache.find(source); hit != cache.end()) {
    *length = hit->second.length;
    return hit->second.bytes;
  }
  if (!context || !dictionary) return source;
  const size_t compressed = ZSTD_findFrameCompressedSize(source, static_cast<size_t>(*length));
  if (ZSTD_isError(compressed)) return source;
  const auto size = ZSTD_getFrameContentSize(source, compressed);
  if (size > std::numeric_limits<int32_t>::max()) return source;
  void* output = std::malloc(static_cast<size_t>(size));
  if (!output) return source;
  if (ZSTD_decompress_usingDDict(context, output, size, source, compressed, dictionary) != size) {
    std::free(output);
    return source;
  }
  *length = static_cast<int32_t>(size);
  cache.emplace(source, Item{output, *length});
  return output;
}
