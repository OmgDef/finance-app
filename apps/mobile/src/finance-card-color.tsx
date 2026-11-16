import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { GestureResponderEvent, ViewProps } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { CardNetwork, Language } from '@teta/contracts';
import { copy } from './copy';
import { CardNetworkLogo } from './finance-card-network';
import { financeCopy } from './finance-copy';
import { FinanceIcon } from './finance-icon';
import { FinanceAlert, FinanceButton, FinanceField, palette, styles } from './finance-ui';

type Color = { hue: number; saturation: number; brightness: number };
type Props = { value: string; onChange: (color: string) => void; lang: Language; network: CardNetwork | null; disabled: boolean };
const clamp = (value: number, max = 1) => Math.min(max, Math.max(0, value));

function fromHex(hex: string): Color {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const brightness = Math.max(r, g, b);
  const range = brightness - Math.min(r, g, b);
  const sector = !range ? 0 : brightness === r ? (g - b) / range
    : brightness === g ? 2 + (b - r) / range : 4 + (r - g) / range;
  return { hue: (sector * 60 + 360) % 360, saturation: brightness ? range / brightness : 0, brightness };
}

function toHex({ hue, saturation, brightness }: Color) {
  const channels = [5, 3, 1].map((offset) => {
    const sector = (offset + hue / 60) % 6;
    const channel = brightness * (1 - saturation * clamp(Math.min(sector, 4 - sector)));
    return Math.round(channel * 255).toString(16).padStart(2, '0'); // taste-skill-ignore: two digits per HEX channel.
  });
  return ('#' + channels.join('')).toUpperCase();
}

function normalizeHex(input: string) {
  const hex = input.trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toUpperCase() : undefined;
}

export function CardColorField({ value, onChange, lang, network, disabled }: Props) {
  const t = financeCopy[lang];
  const [open, setOpen] = useState(false);
  return <View style={styles.field}>
    <Text style={styles.label}>{t.cardColor}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={t.chooseCardColor} accessibilityValue={{ text: value }}
      accessibilityState={{ disabled, expanded: open && !disabled }} disabled={disabled} testID="finance-card-color"
      onPress={() => { void KeyboardController.dismiss(); setOpen(true); }}
      style={({ pressed }) => [styles.input, layout.trigger, (disabled || pressed) && styles.dimmed]}>
      <ColorPreview color={value} network={network} testID="finance-card-preview" />
      <Text style={[styles.inputText, layout.triggerText]}>{t.chooseCardColor}</Text>
      <FinanceIcon name="chevron" color={palette.muted} size={16} />
    </Pressable>
    {open && !disabled && <CardColorPicker value={value} lang={lang} network={network} onChange={onChange}
      onClose={() => setOpen(false)} />}
  </View>;
}

function CardColorPicker({ value, lang, network, onChange, onClose }: Omit<Props, 'disabled'> & { onClose: () => void }) {
  const t = financeCopy[lang];
  const [color, setColor] = useState(() => fromHex(value));
  const [input, setInput] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hex = toHex(color);
  const hue = toHex({ hue: color.hue, saturation: 1, brightness: 1 });

  function select(update: Partial<Color>) {
    setColor((current) => ({ ...current, ...update }));
    setInput(undefined);
    setInvalid(false);
  }

  function apply() {
    const selected = input === undefined ? hex : normalizeHex(input);
    if (!selected) return setInvalid(true);
    void KeyboardController.dismiss();
    onChange(selected);
    onClose();
  }

  return <Modal transparent animationType="fade" onRequestClose={onClose}>
    <SafeAreaProvider>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={layout.modal}>
        <Pressable accessible={false} onPress={onClose} style={layout.backdrop} />
        <View style={layout.sheet} accessibilityViewIsModal testID="finance-card-color-picker">
          <ScrollView bounces={false} contentInsetAdjustmentBehavior="never"
            keyboardShouldPersistTaps="handled" scrollEnabled={!dragging}>
            <SafeAreaView edges={['bottom']} style={layout.sheetContent}>
              <View style={layout.heading}>
                <Text style={[styles.section, layout.triggerText]} accessibilityRole="header">{t.cardColor}</Text>
                <ColorPreview color={hex} network={network} testID="finance-card-color-preview" />
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>{t.cardColorShade}</Text>
                <ColorTrack style={layout.shade} testID="finance-card-color-shade" accessibilityLabel={t.cardColorShade}
                  accessibilityValue={{ text: `${t.cardColorShade}: ${Math.round(color.saturation * 100)}%, ${Math.round(color.brightness * 100)}%` }}
                  accessibilityActions={[{ name: 'increment' }, { name: 'decrement' },
                    { name: 'saturationUp', label: t.increaseSaturation }, { name: 'saturationDown', label: t.decreaseSaturation }]}
                  onAccessibilityAction={({ nativeEvent: { actionName } }) => {
                    if (actionName === 'increment' || actionName === 'decrement') {
                      select({ brightness: clamp(color.brightness + (actionName === 'increment' ? 0.05 : -0.05)) });
                    } else if (actionName === 'saturationUp' || actionName === 'saturationDown') {
                      select({ saturation: clamp(color.saturation + (actionName === 'saturationUp' ? 0.05 : -0.05)) });
                    }
                  }} onDrag={setDragging} onSelect={(x, y) => select({ saturation: x, brightness: 1 - y })}>
                  <View style={[layout.gradient, layout.shadeGradient, { backgroundColor: hue }]} />
                  <View style={[layout.thumb, { left: `${color.saturation * 100}%`, top: `${(1 - color.brightness) * 100}%`, backgroundColor: hex }]} />
                </ColorTrack>
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>{t.cardColorHue}</Text>
                <ColorTrack style={layout.hue} testID="finance-card-color-hue" accessibilityLabel={t.cardColorHue}
                  accessibilityValue={{ min: 0, max: 360, now: Math.round(color.hue) }}
                  accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                  onAccessibilityAction={({ nativeEvent: { actionName } }) => {
                    select({ hue: clamp(color.hue + (actionName === 'increment' ? 10 : -10), 360) });
                  }} onDrag={setDragging} onSelect={(x) => select({ hue: x * 360 })}>
                  <View style={[layout.gradient, layout.hueGradient]} />
                  <View style={[layout.thumb, { left: `${color.hue / 3.6}%`, top: '50%', backgroundColor: hue }]} />
                </ColorTrack>
              </View>
              <FinanceField title={t.cardColorHex} value={input ?? hex} maxLength={7} keyboardType="ascii-capable" selectTextOnFocus
                autoCapitalize="characters" testID="finance-card-color-hex" onChangeText={(text) => {
                  setInput(text);
                  setInvalid(false);
                  const entered = normalizeHex(text);
                  if (entered) setColor(fromHex(entered));
                }} />
              {invalid && <FinanceAlert>{t.invalidCardColor}</FinanceAlert>}
              <View style={layout.actions}>
                <FinanceButton title={copy[lang].cancel} onPress={onClose} testID="finance-card-color-cancel" />
                <FinanceButton title={copy[lang].done} primary onPress={apply} testID="finance-card-color-done" />
              </View>
            </SafeAreaView>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaProvider>
  </Modal>;
}

function ColorTrack({ children, onSelect, onDrag, ...props }: ViewProps & {
  onSelect: (x: number, y: number) => void; onDrag: (dragging: boolean) => void;
}) {
  const size = useRef({ width: 0, height: 0 });
  function move({ nativeEvent: { locationX, locationY } }: GestureResponderEvent) {
    const { width, height } = size.current;
    if (width && height) onSelect(clamp(locationX / width), clamp(locationY / height));
  }
  return <View {...props} accessible accessibilityRole="adjustable"
    onLayout={({ nativeEvent: { layout: { width, height } } }) => { size.current = { width, height }; }}
    onStartShouldSetResponder={() => true} onResponderTerminationRequest={() => false}
    onResponderGrant={(event) => { onDrag(true); move(event); }} onResponderMove={move}
    onResponderRelease={() => onDrag(false)} onResponderTerminate={() => onDrag(false)}>
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>{children}</View>
  </View>;
}

function ColorPreview({ color, network, testID }: { color: string; network: CardNetwork | null; testID: string }) {
  return <View style={[layout.swatch, { backgroundColor: color }]} testID={testID}>
    <CardNetworkLogo network={network} appearance={color} />
  </View>;
}

const layout = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  triggerText: { flex: 1 },
  swatch: { width: 52, height: 32, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: '#00000033',
    alignItems: 'center', justifyContent: 'center' },
  modal: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(23, 38, 58, 0.35)' },
  sheet: { width: '100%', maxWidth: 420, maxHeight: '90%', backgroundColor: palette.panel,
    borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  sheetContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, gap: 12 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  shade: { height: 144 },
  hue: { height: 44 },
  gradient: { ...StyleSheet.absoluteFill, borderRadius: 8 },
  shadeGradient: {
    experimental_backgroundImage: 'linear-gradient(to bottom, #00000000, #000000), linear-gradient(to right, #FFFFFF, #FFFFFF00)', // taste-skill-ignore: color selection surface.
  },
  hueGradient: { top: 9, bottom: 9,
    experimental_backgroundImage: 'linear-gradient(to right, #F00, #FF0, #0F0, #0FF, #00F, #F0F, #F00)', // taste-skill-ignore: selectable hue spectrum.
  },
  thumb: { position: 'absolute', width: 22, height: 22, transform: [{ translateX: -11 }, { translateY: -11 }],
    borderRadius: 11, borderWidth: 2, borderColor: palette.panel, outlineWidth: 1, outlineColor: '#00000080' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
});
