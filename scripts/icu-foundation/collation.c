// icu's collator api on CoreFoundation, so the runtime needs no collation data.
// JavaScriptCore's Intl.Collator and localeCompare call only these functions.
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <string.h>
#include <unicode/ucol.h>
#include <unicode/uenum.h>
#include <unicode/uloc.h>
#include "shim.h"

struct UCollator {
  CFLocaleRef locale;
  UColAttributeValue strength;
  UColAttributeValue numeric;
  UColAttributeValue caseFirst;
  UColAttributeValue alternate;
  UColAttributeValue caseLevel;
};

U_CAPI UCollator* U_EXPORT2 ucol_open(const char* loc, UErrorCode* status) {
  if (U_FAILURE(*status)) return NULL;
  UCollator* c = calloc(1, sizeof(UCollator));
  c->locale = shim_locale(loc);
  c->strength = UCOL_TERTIARY;
  c->numeric = UCOL_OFF;
  c->caseFirst = UCOL_OFF;
  c->alternate = UCOL_NON_IGNORABLE;
  c->caseLevel = UCOL_OFF;
  char value[32];
  UErrorCode e = U_ZERO_ERROR;
  if (uloc_getKeywordValue(loc, "colnumeric", value, sizeof value, &e) > 0 && U_SUCCESS(e) && !strcmp(value, "yes"))
    c->numeric = UCOL_ON;
  e = U_ZERO_ERROR;
  if (uloc_getKeywordValue(loc, "colcasefirst", value, sizeof value, &e) > 0 && U_SUCCESS(e))
    c->caseFirst = !strcmp(value, "upper") ? UCOL_UPPER_FIRST : !strcmp(value, "lower") ? UCOL_LOWER_FIRST : UCOL_OFF;
  return c;
}

U_CAPI void U_EXPORT2 ucol_close(UCollator* c) {
  if (!c) return;
  CFRelease(c->locale);
  free(c);
}

U_CAPI void U_EXPORT2 ucol_setAttribute(UCollator* c, UColAttribute attr, UColAttributeValue value, UErrorCode* status) {
  if (U_FAILURE(*status)) return;
  switch (attr) {
  case UCOL_STRENGTH: c->strength = value == UCOL_DEFAULT ? UCOL_TERTIARY : value; break;
  case UCOL_NUMERIC_COLLATION: c->numeric = value; break;
  case UCOL_CASE_FIRST: c->caseFirst = value; break;
  case UCOL_ALTERNATE_HANDLING: c->alternate = value; break;
  case UCOL_CASE_LEVEL: c->caseLevel = value; break;
  default: break;
  }
}

U_CAPI UColAttributeValue U_EXPORT2 ucol_getAttribute(const UCollator* c, UColAttribute attr, UErrorCode* status) {
  if (U_FAILURE(*status)) return UCOL_DEFAULT;
  switch (attr) {
  case UCOL_STRENGTH: return c->strength;
  case UCOL_NUMERIC_COLLATION: return c->numeric;
  case UCOL_CASE_FIRST: return c->caseFirst;
  case UCOL_ALTERNATE_HANDLING: return c->alternate;
  case UCOL_CASE_LEVEL: return c->caseLevel;
  case UCOL_NORMALIZATION_MODE: return UCOL_ON;
  default: return UCOL_OFF;
  }
}

// punctuation and whitespace drop out of both sides when alternate handling shifts them
static CFStringRef shifted(CFStringRef s) {
  CFMutableStringRef m = CFStringCreateMutableCopy(NULL, 0, s);
  CFCharacterSetRef punct = CFCharacterSetGetPredefined(kCFCharacterSetPunctuation);
  CFCharacterSetRef space = CFCharacterSetGetPredefined(kCFCharacterSetWhitespaceAndNewline);
  CFCharacterSetRef symbol = CFCharacterSetGetPredefined(kCFCharacterSetSymbol);
  for (CFIndex i = CFStringGetLength(m); i-- > 0;) {
    UniChar ch = CFStringGetCharacterAtIndex(m, i);
    if (CFCharacterSetIsCharacterMember(punct, ch) || CFCharacterSetIsCharacterMember(space, ch) || CFCharacterSetIsCharacterMember(symbol, ch))
      CFStringDelete(m, CFRangeMake(i, 1));
  }
  return m;
}

static UCollationResult compare(const UCollator* c, CFStringRef a, CFStringRef b) {
  CFStringCompareFlags flags = kCFCompareLocalized | kCFCompareNonliteral;
  if (c->strength == UCOL_PRIMARY) flags |= kCFCompareCaseInsensitive | kCFCompareDiacriticInsensitive | kCFCompareWidthInsensitive;
  else if (c->strength == UCOL_SECONDARY) flags |= kCFCompareCaseInsensitive | kCFCompareWidthInsensitive;
  if (c->caseLevel == UCOL_ON && c->strength == UCOL_PRIMARY) flags &= ~kCFCompareCaseInsensitive;
  if (c->numeric == UCOL_ON) flags |= kCFCompareNumerically;
  CFStringRef x = a, y = b;
  if (c->alternate == UCOL_SHIFTED) {
    x = shifted(a);
    y = shifted(b);
  }
  CFComparisonResult r = CFStringCompareWithOptionsAndLocale(x, y, CFRangeMake(0, CFStringGetLength(x)), flags, c->locale);
  // foundation puts lowercase first at tertiary strength; caseFirst upper flips ties that differ only by case
  if (r != kCFCompareEqualTo && c->caseFirst == UCOL_UPPER_FIRST && c->strength >= UCOL_TERTIARY &&
      CFStringCompareWithOptionsAndLocale(x, y, CFRangeMake(0, CFStringGetLength(x)), flags | kCFCompareCaseInsensitive, c->locale) == kCFCompareEqualTo)
    r = -r;
  if (x != a) CFRelease(x);
  if (y != b) CFRelease(y);
  return r == kCFCompareLessThan ? UCOL_LESS : r == kCFCompareGreaterThan ? UCOL_GREATER : UCOL_EQUAL;
}

U_CAPI UCollationResult U_EXPORT2 ucol_strcoll(const UCollator* c, const UChar* s, int32_t sl, const UChar* t, int32_t tl) {
  CFStringRef a = CFStringCreateWithCharactersNoCopy(NULL, s, sl < 0 ? shim_u_strlen(s) : sl, kCFAllocatorNull);
  CFStringRef b = CFStringCreateWithCharactersNoCopy(NULL, t, tl < 0 ? shim_u_strlen(t) : tl, kCFAllocatorNull);
  UCollationResult r = compare(c, a, b);
  CFRelease(a);
  CFRelease(b);
  return r;
}

U_CAPI UCollationResult U_EXPORT2 ucol_strcollUTF8(const UCollator* c, const char* s, int32_t sl, const char* t, int32_t tl, UErrorCode* status) {
  if (U_FAILURE(*status)) return UCOL_EQUAL;
  CFStringRef a = CFStringCreateWithBytes(NULL, (const UInt8*)s, sl < 0 ? (CFIndex)strlen(s) : sl, kCFStringEncodingUTF8, false);
  CFStringRef b = CFStringCreateWithBytes(NULL, (const UInt8*)t, tl < 0 ? (CFIndex)strlen(t) : tl, kCFStringEncodingUTF8, false);
  UCollationResult r = compare(c, a, b);
  CFRelease(a);
  CFRelease(b);
  return r;
}

// a root-like collator: JavaScriptCore checks for empty rules before its ascii fast path
U_CAPI const UChar* U_EXPORT2 ucol_getRules(const UCollator* c, int32_t* length) {
  static const UChar none[1] = {0};
  *length = 0;
  return none;
}

U_CAPI int32_t U_EXPORT2 ucol_countAvailable(void) { return shim_available_count(); }
U_CAPI const char* U_EXPORT2 ucol_getAvailable(int32_t i) { return shim_available(i); }

U_CAPI UEnumeration* U_EXPORT2 ucol_getKeywordValues(const char* keyword, UErrorCode* status) {
  static const char* const values[] = {"standard", "search"};
  return uenum_openCharStringsEnumeration(values, 2, status);
}

U_CAPI UEnumeration* U_EXPORT2 ucol_getKeywordValuesForLocale(const char* key, const char* locale, UBool commonlyUsed, UErrorCode* status) {
  static const char* const values[] = {"standard", "search"};
  return uenum_openCharStringsEnumeration(values, 2, status);
}
