#include "shim.h"
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

CFLocaleRef shim_locale(const char* icu_locale) {
  CFStringRef id = CFStringCreateWithCString(NULL, icu_locale && *icu_locale ? icu_locale : "en_US_POSIX", kCFStringEncodingUTF8);
  CFStringRef canonical = CFLocaleCreateCanonicalLocaleIdentifierFromString(NULL, id);
  CFLocaleRef locale = CFLocaleCreate(NULL, canonical);
  CFRelease(canonical);
  CFRelease(id);
  return locale;
}

int32_t shim_u_strlen(const UChar* s) {
  int32_t n = 0;
  while (s[n]) n++;
  return n;
}

static char** available;
static int32_t available_count;
static pthread_once_t available_once = PTHREAD_ONCE_INIT;

static void load_available(void) {
  CFArrayRef ids = CFLocaleCopyAvailableLocaleIdentifiers();
  CFIndex n = CFArrayGetCount(ids);
  available = calloc(n, sizeof(char*));
  for (CFIndex i = 0; i < n; i++) {
    char buf[96];
    if (CFStringGetCString(CFArrayGetValueAtIndex(ids, i), buf, sizeof buf, kCFStringEncodingUTF8)) available[available_count++] = strdup(buf);
  }
  CFRelease(ids);
}

int32_t shim_available_count(void) {
  pthread_once(&available_once, load_available);
  return available_count;
}

const char* shim_available(int32_t index) {
  pthread_once(&available_once, load_available);
  return index >= 0 && index < available_count ? available[index] : NULL;
}

int32_t shim_copy_out(CFStringRef s, UChar* dest, int32_t capacity, UErrorCode* status) {
  int32_t length = (int32_t)CFStringGetLength(s);
  if (length > capacity) {
    *status = U_BUFFER_OVERFLOW_ERROR;
    return length;
  }
  CFStringGetCharacters(s, CFRangeMake(0, length), (UniChar*)dest);
  if (length < capacity) dest[length] = 0;
  else *status = U_STRING_NOT_TERMINATED_WARNING;
  return length;
}
