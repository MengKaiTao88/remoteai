import { Image, Keyboard, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LOUNGE_IMAGE_EDITOR_LIMITS, useLoungeImageEditor,
  type LoungeImageAttachmentsProps } from '../../../../shared/lounge/useLoungeImageEditor';
import { ChatPhotoEditor } from '../chat/ChatPhotoEditor';
import { t } from '../i18n';
import { textMetrics } from '../theme/text';
import { createLoungeStyles, useLoungeColor } from './theme';
import { useLoungeStyles } from './styles';

export function LoungeImageAttachments(props: LoungeImageAttachmentsProps) {
  const { images, setImages, disabled } = props;
  const editor = useLoungeImageEditor(props);
  const styles = useLoungeStyles();
  const editStyles = useEditStyles();
  const color = useLoungeColor();
  return <>
    {!!images.length && <View style={styles.attachments}>{images.map((uri, index) => <View key={index}>
      <Image source={{ uri }} style={styles.attachment} />
      <Pressable accessibilityRole="button" accessibilityLabel={t('client.lounge.removeImage')}
        disabled={disabled} style={styles.remove}
        onPress={() => setImages(current => current.filter((_, at) => at !== index))}>
        <Ionicons name="close" size={18} color={color('#24262c', 'ink')} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t('client.chat.annotateImage', { value1: index + 1 })}
        disabled={disabled} style={[editStyles.button, disabled && styles.disabled]}
        onPress={() => { Keyboard.dismiss(); editor.open(index); }}>
        <Text style={editStyles.label}>{t('client.chat.annotate')}</Text></Pressable>
    </View>)}</View>}
    {editor.editing && <ChatPhotoEditor photo={{ dataUrl: editor.editing.original }} mode="direct"
      outputLimits={LOUNGE_IMAGE_EDITOR_LIMITS} save={editor.save} close={editor.close} />}
  </>;
}

const useEditStyles = createLoungeStyles(color => ({
  button: { minHeight: 36, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center',
    borderBottomLeftRadius: 6, borderBottomRightRadius: 6, backgroundColor: color('#e9eef1', 'elevated') },
  label: { ...textMetrics(12, 19), color: color('#24262c', 'ink') },
}));
