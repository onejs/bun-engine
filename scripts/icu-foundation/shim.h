// helpers shared by the CoreFoundation implementations of icu's locale services
#pragma once
#include <CoreFoundation/CoreFoundation.h>
#include <unicode/utypes.h>

// a CFLocale for an icu locale id, keywords included (de@collation=phonebook)
CFLocaleRef shim_locale(const char* icu_locale);
int32_t shim_u_strlen(const UChar* s);
// the locales the operating system formats, as icu ids
int32_t shim_available_count(void);
const char* shim_available(int32_t index);
// writes s into dest as icu's buffer-producing functions do: the full length is returned,
// and a too-small buffer reports U_BUFFER_OVERFLOW_ERROR
int32_t shim_copy_out(CFStringRef s, UChar* dest, int32_t capacity, UErrorCode* status);
