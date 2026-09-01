package track

import "strconv"

func itoa(v int) string { return strconv.Itoa(v) }

func ftoa(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }
