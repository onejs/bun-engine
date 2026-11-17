// icu's locale display names on CoreFoundation, so the runtime needs no language or region name data
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <unicode/uldnames.h>
#include <unicode/ures.h>
#include "shim.h"

struct ULocaleDisplayNames {
  CFLocaleRef locale;
  // cldr's contextTransforms: whether a standalone language name starts with a capital
  UBool capitalizeLanguages;
};

static UBool capitalizes_languages(const char* locale) {
  UErrorCode status = U_ZERO_ERROR;
  UResourceBundle* bundle = ures_open(NULL, locale, &status);
  UResourceBundle* transforms = ures_getByKey(bundle, "contextTransforms", NULL, &status);
  UResourceBundle* languages = ures_getByKey(transforms, "languages", NULL, &status);
  int32_t length = 0;
  const int32_t* values = ures_getIntVector(languages, &length, &status);
  UBool capitalize = U_SUCCESS(status) && length > 1 && values[1] == 1;
  ures_close(languages);
  ures_close(transforms);
  ures_close(bundle);
  return capitalize;
}

U_CAPI ULocaleDisplayNames* U_EXPORT2 uldn_openForContext(const char* locale, UDisplayContext* contexts, int32_t length, UErrorCode* status) {
  if (U_FAILURE(*status)) return NULL;
  ULocaleDisplayNames* names = malloc(sizeof(ULocaleDisplayNames));
  names->locale = shim_locale(locale);
  names->capitalizeLanguages = capitalizes_languages(locale);
  return names;
}

U_CAPI void U_EXPORT2 uldn_close(ULocaleDisplayNames* names) {
  if (!names) return;
  CFRelease(names->locale);
  free(names);
}

static int32_t display(const ULocaleDisplayNames* names, CFLocaleKey key, const char* code, UChar* result, int32_t capacity, UErrorCode* status) {
  if (U_FAILURE(*status)) return 0;
  CFStringRef value = CFStringCreateWithCString(NULL, code, kCFStringEncodingUTF8);
  CFStringRef name = value ? CFLocaleCopyDisplayNameForPropertyValue(names->locale, key, value) : NULL;
  if (value) CFRelease(value);
  // icu reports a code without a name as an illegal argument
  if (!name) {
    *status = U_ILLEGAL_ARGUMENT_ERROR;
    return 0;
  }
  if (key == kCFLocaleIdentifier && names->capitalizeLanguages && CFStringGetLength(name)) {
    CFMutableStringRef first = CFStringCreateMutableCopy(NULL, 0, name);
    CFStringRef head = CFStringCreateWithSubstring(NULL, name, CFRangeMake(0, 1));
    CFMutableStringRef upper = CFStringCreateMutableCopy(NULL, 0, head);
    CFStringUppercase(upper, names->locale);
    CFStringReplace(first, CFRangeMake(0, 1), upper);
    CFRelease(upper);
    CFRelease(head);
    CFRelease(name);
    name = first;
  }
  int32_t length = shim_copy_out(name, result, capacity, status);
  CFRelease(name);
  return length;
}

U_CAPI int32_t U_EXPORT2 uldn_localeDisplayName(const ULocaleDisplayNames* names, const char* locale, UChar* result, int32_t capacity, UErrorCode* status) {
  return display(names, kCFLocaleIdentifier, locale, result, capacity, status);
}

U_CAPI int32_t U_EXPORT2 uldn_regionDisplayName(const ULocaleDisplayNames* names, const char* region, UChar* result, int32_t capacity, UErrorCode* status) {
  return display(names, kCFLocaleCountryCode, region, result, capacity, status);
}

U_CAPI int32_t U_EXPORT2 uldn_scriptDisplayName(const ULocaleDisplayNames* names, const char* script, UChar* result, int32_t capacity, UErrorCode* status) {
  return display(names, kCFLocaleScriptCode, script, result, capacity, status);
}

U_CAPI int32_t U_EXPORT2 uldn_keyValueDisplayName(const ULocaleDisplayNames* names, const char* key, const char* value, UChar* result, int32_t capacity, UErrorCode* status) {
  return display(names, kCFLocaleCalendarIdentifier, value, result, capacity, status);
}
